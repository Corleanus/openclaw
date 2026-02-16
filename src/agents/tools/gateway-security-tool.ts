import { isIP } from "node:net";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/io.js";
import { writeConfigFile } from "../../config/io.js";
import { stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";
import { callGatewayTool } from "./gateway.js";

const SECURITY_ACTIONS = ["list_banned", "unban", "reset_password"] as const;

const GatewaySecurityToolSchema = Type.Object({
  action: stringEnum(SECURITY_ACTIONS),
  ip: Type.Optional(Type.String()),
  password: Type.Optional(Type.String()),
});

export function createGatewaySecurityTool(opts?: {
  config?: OpenClawConfig;
}): AnyAgentTool {
  return {
    label: "Gateway Security",
    name: "gateway_security",
    description:
      "Manage gateway approval security: list banned IPs, unban an IP, or reset the approval password. WARNING: reset_password triggers a gateway restart — active connections will be dropped.",
    parameters: GatewaySecurityToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });

      if (action === "list_banned") {
        const result = await callGatewayTool("gateway.security.bans.list", {}, {});
        return jsonResult({ ok: true, ...result });
      }

      if (action === "unban") {
        const ip = readStringParam(params, "ip", { required: true });
        if (!ip) {
          return jsonResult({ ok: false, error: "ip is required for unban" });
        }
        if (!isIP(ip)) {
          return jsonResult({ ok: false, error: "invalid IP address" });
        }
        const result = await callGatewayTool("gateway.security.bans.unban", {}, { ip });
        return jsonResult({ ok: true, ...result });
      }

      if (action === "reset_password") {
        const password = readStringParam(params, "password");
        // Validate ASCII printable if provided
        if (password && password.length < 8) {
          return jsonResult({
            ok: false,
            error: "password must be at least 8 characters",
          });
        }
        if (password && !/^[\x20-\x7E]+$/.test(password)) {
          return jsonResult({
            ok: false,
            error: "Password must contain only ASCII printable characters (0x20-0x7E)",
          });
        }

        const cfg = loadConfig();
        const nextConfig = structuredClone(cfg);
        if (!nextConfig.gateway) {
          nextConfig.gateway = {};
        }
        if (!nextConfig.gateway.auth) {
          nextConfig.gateway.auth = {};
        }
        if (!nextConfig.gateway.auth.approval) {
          nextConfig.gateway.auth.approval = {};
        }

        if (password) {
          nextConfig.gateway.auth.approval.password = password;
        } else {
          delete nextConfig.gateway.auth.approval.password;
        }

        await writeConfigFile(nextConfig);
        return jsonResult({
          ok: true,
          message: password
            ? "Approval password updated. Gateway will restart — active connections will be dropped."
            : "Approval password removed. Gateway will restart — active connections will be dropped.",
        });
      }

      return jsonResult({ ok: false, error: `Unknown action: ${action}` });
    },
  };
}
