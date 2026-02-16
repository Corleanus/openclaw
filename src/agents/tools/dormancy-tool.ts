import { Type } from "@sinclair/typebox";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { loadConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import {
  DEFAULT_AGENT_ID,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope.js";
import {
  activateAgent,
  deactivateAgent,
  getDormancyState,
} from "../dormancy/dormancy.js";
import { jsonResult, readStringParam } from "./common.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-helpers.js";

const DormancyToolSchema = Type.Object({
  action: stringEnum(["activate", "deactivate", "status"]),
  agentId: Type.String(),
  historyLimit: Type.Optional(Type.Number({ minimum: 0, maximum: 50 })),
});

export function createDormancyTool(opts?: {
  agentSessionKey?: string;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
}): AnyAgentTool {
  return {
    label: "Agent Dormancy",
    name: "agent_dormancy",
    description: "Manage agent dormancy state (activate, deactivate, or get status).",
    parameters: DormancyToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const targetAgentId = normalizeAgentId(readStringParam(params, "agentId", { required: true }));
      const historyLimit =
        typeof params.historyLimit === "number" && Number.isFinite(params.historyLimit)
          ? Math.max(0, Math.min(50, Math.floor(params.historyLimit)))
          : 0;

      const cfg = loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const requesterInternalKey =
        typeof opts?.agentSessionKey === "string" && opts.agentSessionKey.trim()
          ? resolveInternalSessionKey({
              key: opts.agentSessionKey,
              alias,
              mainKey,
            })
          : alias;
      const requesterAgentId = normalizeAgentId(
        opts?.requesterAgentIdOverride ??
          parseAgentSessionKey(requesterInternalKey)?.agentId ??
          DEFAULT_AGENT_ID,
      );

      // Authorization: Check subagents.allowAgents from requester's agent config
      if (targetAgentId !== requesterAgentId) {
        const allowAgents = resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ?? [];
        const allowAny = allowAgents.some((value) => value.trim() === "*");
        const normalizedTargetId = targetAgentId.toLowerCase();
        const allowSet = new Set(
          allowAgents
            .filter((value) => value.trim() && value.trim() !== "*")
            .map((value) => normalizeAgentId(value).toLowerCase()),
        );

        if (!allowAny && !allowSet.has(normalizedTargetId)) {
          const allowedText = allowAny
            ? "*"
            : allowSet.size > 0
              ? Array.from(allowSet).join(", ")
              : "none";
          return jsonResult({
            status: "forbidden",
            error: `agentId is not allowed for agent_dormancy (allowed: ${allowedText})`,
          });
        }
      }

      // Execute action
      if (action === "status") {
        const state = getDormancyState(targetAgentId);
        return jsonResult({
          status: "success",
          agentId: targetAgentId,
          state,
        });
      }

      if (action === "deactivate") {
        const state = deactivateAgent(targetAgentId, requesterAgentId);
        return jsonResult({
          status: "success",
          agentId: targetAgentId,
          state,
        });
      }

      if (action === "activate") {
        const state = activateAgent(targetAgentId, requesterAgentId);
        const result: Record<string, unknown> = {
          status: "success",
          agentId: targetAgentId,
          state,
        };

        // Optionally fetch recent history
        if (historyLimit > 0) {
          try {
            const historyResponse = await callGateway<{ messages?: unknown[] }>({
              method: "chat.history",
              params: {
                sessionKey: `agent:${targetAgentId}:main`,
                limit: historyLimit,
              },
              timeoutMs: 10_000,
            });
            if (Array.isArray(historyResponse?.messages)) {
              result.recentHistory = historyResponse.messages;
            }
          } catch (err) {
            // Best-effort: don't fail activation on history fetch failure
            const messageText =
              err instanceof Error ? err.message : typeof err === "string" ? err : "error";
            result.historyWarning = `Failed to fetch recent history: ${messageText}`;
          }
        }

        return jsonResult(result);
      }

      return jsonResult({
        status: "error",
        error: `Invalid action: ${action}`,
      });
    },
  };
}
