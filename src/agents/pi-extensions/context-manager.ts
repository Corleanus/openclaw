import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  ExtensionAPI,
  ContextEvent,
  ExtensionContext,
  ToolResultEvent,
  FileOperations,
} from "@mariozechner/pi-coding-agent";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getContextManagerRuntime } from "./context-manager-runtime.js";
import type { ContextManagerRuntimeValue } from "./context-manager-runtime.js";
import { calculateUtilization, formatGaugeLine } from "../context-gauge.js";
import type { GaugeResult } from "../context-gauge.js";
import { writeCheckpoint, pruneOldCheckpoints, readLatestCheckpoint } from "../context-checkpoint.js";
import type {
  Checkpoint,
  CheckpointTrigger,
  CheckpointResources,
} from "../context-checkpoint.js";
import {
  initStateDir,
  readStateFiles,
  appendToolToState,
  appendFileToState,
  appendDecisionToState,
  appendOpenItemToState,
  appendLearningToState,
} from "../context-state.js";
import type { StateFiles } from "../context-state.js";
import { readCheckpointForInjection } from "../context-checkpoint-inject.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";

const log = createSubsystemLogger("context-manager");

// ---------- Session-scoped tracking ----------

const initializedSessions = new Set<string>();
const resumeInjected = new Set<string>();

// ---------- Helper functions ----------

function findLastUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { role?: string })?.role === "user") return messages[i];
  }
  return undefined;
}

function findFirstUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (const msg of messages) {
    if ((msg as { role?: string })?.role === "user") return msg;
  }
  return undefined;
}

function extractText(msg: AgentMessage): string {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // Extract text blocks
    const textParts = content
      .filter(
        (b: unknown) =>
          typeof b === "object" && b !== null && (b as { type?: string }).type === "text",
      )
      .map((b: unknown) => (b as { text?: string }).text ?? "");
    if (textParts.length > 0) return textParts.join("\n");
    // Fallback: if content is all tool calls, summarize tool names
    const toolNames = content
      .filter(
        (b: unknown) =>
          typeof b === "object" && b !== null &&
          ((b as { type?: string }).type === "tool_use" || (b as { type?: string }).type === "tool_call"),
      )
      .map((b: unknown) => (b as { name?: string }).name)
      .filter(Boolean);
    if (toolNames.length > 0) return `[called ${toolNames.join(", ")}]`;
  }
  return "";
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : text.slice(0, maxLen - 3) + "...";
}

function buildThreadSummary(
  first: AgentMessage | undefined,
  last: AgentMessage | undefined,
): string {
  const firstText = first ? truncate(extractText(first), 100) : "";
  const lastText = last ? truncate(extractText(last), 100) : "";
  if (firstText && lastText && first !== last) return `${firstText} ... ${lastText}`;
  return firstText || lastText || "No conversation context";
}

function buildKeyExchanges(
  messages: AgentMessage[],
): Array<{ role: "user" | "agent"; gist: string }> {
  const exchanges: Array<{ role: "user" | "agent"; gist: string }> = [];
  const userAgentPairs: Array<{ user: AgentMessage; agent?: AgentMessage }> = [];

  // Collect user-agent pairs — scan forward past custom/toolResult messages
  // to find the next assistant message after each user message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as { role?: string };
    if (msg?.role === "user") {
      let agent: AgentMessage | undefined;
      for (let j = i + 1; j < messages.length; j++) {
        const candidate = messages[j] as { role?: string };
        if (candidate?.role === "assistant") {
          agent = messages[j];
          break;
        }
        // Stop scanning if we hit the next user message
        if (candidate?.role === "user") break;
      }
      userAgentPairs.push({ user: messages[i], agent });
    }
  }

  if (userAgentPairs.length === 0) return [];

  // Always include first
  const first = userAgentPairs[0];
  exchanges.push({ role: "user", gist: truncate(extractText(first.user), 120) });
  if (first.agent) {
    exchanges.push({ role: "agent", gist: truncate(extractText(first.agent), 120) });
  }

  // Include decision points (short user reply after long agent response)
  for (let i = 1; i < userAgentPairs.length - 2; i++) {
    const prevAgent = userAgentPairs[i - 1]?.agent;
    if (prevAgent && extractText(prevAgent).length > 500) {
      const userText = extractText(userAgentPairs[i].user);
      if (userText.length < 50) {
        exchanges.push({ role: "user", gist: truncate(userText, 120) });
      }
    }
  }

  // Always include last 2 pairs
  const lastPairs = userAgentPairs.slice(-2);
  for (const pair of lastPairs) {
    if (pair === first) continue; // Skip if already included
    exchanges.push({ role: "user", gist: truncate(extractText(pair.user), 120) });
    if (pair.agent) {
      exchanges.push({ role: "agent", gist: truncate(extractText(pair.agent), 120) });
    }
  }

  return exchanges.slice(0, 8); // Cap at 8
}

function summarizeToolParams(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  const SAFE_KEYS = ["path", "file_path", "query", "command", "url", "pattern", "glob"];
  for (const key of SAFE_KEYS) {
    if (typeof input[key] === "string") {
      const val = input[key] as string;
      return `${key}=${val.length > 80 ? val.slice(0, 77) + "..." : val}`;
    }
  }
  return Object.keys(input).slice(0, 3).join(", ");
}

function extractChannel(sessionKey: string): string | null {
  const colonIdx = sessionKey.indexOf(":");
  return colonIdx > 0 ? sessionKey.slice(0, colonIdx) : null;
}

// ---------- Exported checkpoint builder ----------

export function buildCheckpointFromState(
  stateFiles: StateFiles,
  gauge: GaugeResult,
  messages: AgentMessage[],
  runtime: ContextManagerRuntimeValue,
  trigger: CheckpointTrigger,
  options?: { isSplitTurn?: boolean; fileOps?: FileOperations; compactionCount?: number },
): Checkpoint {
  // Extract topic from last user message
  const lastUserMsg = findLastUserMessage(messages);
  const topic = lastUserMsg ? truncate(extractText(lastUserMsg), 200) : "Unknown topic";

  // Build thread summary from first + last user messages
  const firstUserMsg = findFirstUserMessage(messages);
  const threadSummary = buildThreadSummary(firstUserMsg, lastUserMsg);

  // Build key exchanges (subsample: first, decision points, last 2 pairs)
  const keyExchanges = buildKeyExchanges(messages);

  // Merge file ops from compaction preparation if available, with scoring
  const now = new Date();
  const nowIso = now.toISOString();
  const fileMap = new Map<string, { path: string; access_count: number; last_accessed: string; kind: "read" | "modified" }>();
  for (const f of stateFiles.resources.files) {
    fileMap.set(f.path, { path: f.path, access_count: f.access_count, last_accessed: f.last_accessed, kind: f.kind });
  }
  if (options?.fileOps) {
    for (const p of options.fileOps.read) {
      if (!fileMap.has(p)) {
        fileMap.set(p, { path: p, access_count: 1, last_accessed: nowIso, kind: "read" });
      }
    }
    for (const p of [...options.fileOps.edited, ...options.fileOps.written]) {
      const existing = fileMap.get(p);
      if (existing) {
        existing.kind = "modified";
      } else {
        fileMap.set(p, { path: p, access_count: 1, last_accessed: nowIso, kind: "modified" });
      }
    }
  }
  const scoredFiles = [...fileMap.values()]
    .map((f) => {
      const ageMinutes = Math.max(0, (now.getTime() - new Date(f.last_accessed).getTime()) / 60000);
      const recency = Math.exp(-0.003 * ageMinutes);
      const kindBonus = f.kind === "modified" ? 1.5 : 1.0;
      const score = Math.round(f.access_count * recency * kindBonus * 100) / 100;
      return { path: f.path, access_count: f.access_count, kind: f.kind, score };
    })
    .sort((a, b) => b.score - a.score);
  const resources: CheckpointResources = {
    files: scoredFiles,
    tools_used: [...stateFiles.resources.tools_used],
  };

  return {
    schema: "openclaw/checkpoint",
    schema_version: 2,
    meta: {
      checkpoint_id: "", // Set by writeCheckpoint
      session_key: runtime.sessionKey,
      session_file: null,
      created_at: new Date().toISOString(),
      trigger,
      compaction_count: options?.compactionCount ?? 0,
      token_usage: {
        input_tokens: gauge.inputTokens,
        context_window: gauge.contextWindow,
        utilization: gauge.utilization,
      },
      previous_checkpoint: null, // Set by writeCheckpoint
      channel: extractChannel(runtime.sessionKey),
      agent_id: null,
    },
    working: {
      topic,
      status: "in_progress",
      interrupted: options?.isSplitTurn ?? false,
      last_tool_call: runtime.lastToolCall
        ? { name: runtime.lastToolCall.name, params_summary: runtime.lastToolCall.paramsSummary }
        : null,
      next_action: "",
    },
    decisions: stateFiles.decisions.map((d, i) => ({
      id: d.id ?? `d${i + 1}`,
      what: d.what,
      when: d.when,
    })),
    resources,
    thread: {
      summary: threadSummary,
      key_exchanges: keyExchanges,
    },
    open_items: stateFiles.open_items ?? [],
    learnings: (stateFiles.learnings ?? []).map((l) => l.text),
  };
}

// ---------- Extension ----------

export default function contextManagerExtension(api: ExtensionAPI): void {
  // context event: fires every LLM call
  api.on("context", async (event: ContextEvent, ctx: ExtensionContext) => {
    const runtime = getContextManagerRuntime(ctx.sessionManager);
    if (!runtime) return {};

    // Ensure state directory exists on first context event per session
    if (!initializedSessions.has(runtime.sessionKey)) {
      await initStateDir(runtime.stateDir, runtime.sessionKey);
      initializedSessions.add(runtime.sessionKey);
    }

    // Session resume: inject checkpoint from prior session on first context event
    if (!resumeInjected.has(runtime.sessionKey)) {
      resumeInjected.add(runtime.sessionKey);
      try {
        const resumeContent = await readCheckpointForInjection(
          runtime.stateDir, runtime.sessionKey, "session-resume",
        );
        if (resumeContent) {
          enqueueSystemEvent(resumeContent, { sessionKey: runtime.sessionKey });
          log.info("Injected session-resume checkpoint");
          runtime.feedbackCounters = {
            checkpointInjected: true,
            referencesDetected: 0,
            sectionsReferenced: [],
          };
        }
      } catch (err) {
        log.warn(`Session resume injection failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Calculate utilization
    const usage = ctx.getContextUsage();
    const gauge = calculateUtilization(usage, runtime.contextWindowTokens);

    // If >= 80%: write checkpoint
    let checkpointSaved = false;
    if (gauge.shouldCheckpoint) {
      try {
        const stateFiles = await readStateFiles(runtime.stateDir, runtime.sessionKey);
        const messages = event.messages ?? [];
        const latestCp = await readLatestCheckpoint(runtime.stateDir, runtime.sessionKey);
        const prevCount = latestCp?.meta?.compaction_count ?? 0;
        const checkpoint = buildCheckpointFromState(
          stateFiles,
          gauge,
          messages,
          runtime,
          "auto-80pct",
          { compactionCount: prevCount },
        );
        const result = await writeCheckpoint(runtime.stateDir, runtime.sessionKey, checkpoint);
        if (result.written) {
          // State files are NOT reset — they accumulate across the session.
          // Each checkpoint captures a full snapshot of accumulated state.
          await pruneOldCheckpoints(runtime.stateDir, runtime.sessionKey);
          checkpointSaved = true;
        }
      } catch (err) {
        log.warn(
          `Checkpoint write failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // ---------- Capture heuristics ----------
    const captureMessages = event.messages ?? [];
    if (captureMessages.length >= 2) {
      // Decision capture: detect short user confirmation after long agent response
      try {
        let lastUserIdx = -1;
        let lastAgentBeforeUser = -1;
        for (let i = captureMessages.length - 1; i >= 0; i--) {
          const role = (captureMessages[i] as { role?: string })?.role;
          if (lastUserIdx < 0 && role === "user") {
            lastUserIdx = i;
          } else if (lastUserIdx >= 0 && role === "assistant") {
            lastAgentBeforeUser = i;
            break;
          }
        }
        if (lastUserIdx >= 0 && lastAgentBeforeUser >= 0) {
          const userText = extractText(captureMessages[lastUserIdx]);
          const agentText = extractText(captureMessages[lastAgentBeforeUser]);
          // Very short replies (< 15 chars, no question mark) are structural
          // confirmations regardless of language. Longer short replies need a keyword.
          const isShortConfirmation = userText.length < 15 && !userText.trim().endsWith("?");
          const hasConfirmKeyword = /\b(yes|no|go|do it|ship it|pick|approve|proceed|let's go|sounds good|go ahead|implement|fix|ok|okay|sure|agreed|confirm|da|ja|oui|si|sim|vai)\b/i.test(userText);
          if (
            agentText.length > 0 &&
            userText.length < 50 &&
            agentText.length > 500 &&
            (isShortConfirmation || hasConfirmKeyword)
          ) {
            await appendDecisionToState(runtime.stateDir, runtime.sessionKey, {
              what: truncate(agentText, 200),
              when: new Date().toISOString(),
            });
          }
        }
      } catch (err) {
        log.warn(`Decision capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Open items + learnings capture: scan latest assistant message
      try {
        let latestAssistant: typeof captureMessages[number] | undefined;
        for (let i = captureMessages.length - 1; i >= 0; i--) {
          if ((captureMessages[i] as { role?: string })?.role === "assistant") {
            latestAssistant = captureMessages[i];
            break;
          }
        }
        if (latestAssistant) {
          const assistantText = extractText(latestAssistant);
          if (assistantText.length > 0) {
            const lines = assistantText.split("\n");
            let inCodeFence = false;

            for (const line of lines) {
              if (line.trimStart().startsWith("```")) {
                inCodeFence = !inCodeFence;
                continue;
              }
              if (inCodeFence) continue;

              // Open items: bullet/list line with action keywords, or markdown checkbox
              const isCheckbox = /^\s*-\s*\[\s*\]/.test(line);
              if (
                isCheckbox ||
                (/^[\s]*[-*]|^\s*\d+\./.test(line) &&
                  /\b(need to|TODO|still need|will check|remaining:|next step|haven't yet|FIXME)\b/i.test(line))
              ) {
                const trimmed = truncate(line.trim(), 150);
                await appendOpenItemToState(runtime.stateDir, runtime.sessionKey, trimmed);
              }

              // Learnings: insight keywords + structural marker, or bold-colon pattern (language-agnostic)
              const hasBoldColon = /^\s*\*\*[^*]+\*\*\s*:/.test(line);
              if (
                hasBoldColon ||
                (/\b(turns out|gotcha:|note:|important:|discovered that|the issue was|root cause|lesson:|TIL|caveat:|warning:|beware:)\b/i.test(line) &&
                  (/^[\s]*[-*]/.test(line) || /\*\*/.test(line) || /^\s*[A-Z]/.test(line)))
              ) {
                const trimmed = truncate(line.trim(), 200);
                await appendLearningToState(runtime.stateDir, runtime.sessionKey, {
                  text: trimmed,
                  when: new Date().toISOString(),
                });
              }
            }
          }
        }
      } catch (err) {
        log.warn(`Open items/learnings capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // If >= 70%: inject gauge line into agent context via CustomMessage
    if (gauge.shouldInject) {
      const gaugeLine = formatGaugeLine(gauge, checkpointSaved);
      log.info(gaugeLine);
      const gaugeMsg = {
        role: "custom" as const,
        customType: "system-event",
        content: gaugeLine,
        display: false,
        timestamp: Date.now(),
      };
      return { messages: [...event.messages, gaugeMsg as AgentMessage] };
    }

    return {};
  });

  // tool_result event: fires after each tool call
  api.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    const runtime = getContextManagerRuntime(ctx.sessionManager);
    if (!runtime) {
      log.debug("tool_result: no runtime found for sessionManager");
      return;
    }

    const toolName = event.toolName;
    log.debug(`tool_result: capturing tool=${toolName}`);

    // Capture tool name to resources
    await appendToolToState(runtime.stateDir, runtime.sessionKey, toolName).catch((err) => {
      log.warn(`Failed to append tool ${toolName} to state: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Track last tool call on runtime
    runtime.lastToolCall = {
      name: toolName,
      paramsSummary: summarizeToolParams(event.input as Record<string, unknown> | undefined),
    };

    // Capture file paths from read/write/edit tools
    const input = event.input as Record<string, unknown> | undefined;
    if (input) {
      const filePath =
        typeof input.path === "string"
          ? input.path
          : typeof input.file_path === "string"
            ? input.file_path
            : null;
      if (filePath) {
        const kind =
          toolName === "read" || toolName === "grep" || toolName === "find" || toolName === "ls"
            ? "read"
            : "modified";
        await appendFileToState(runtime.stateDir, runtime.sessionKey, filePath, kind).catch(
          (err) => {
            log.warn(`Failed to append file ${filePath} to state: ${err instanceof Error ? err.message : String(err)}`);
          },
        );
      }
    }
  });

  // message_end event: track assistant references to checkpoint data
  api.on("message_end", (event, ctx: ExtensionContext) => {
    const runtime = getContextManagerRuntime(ctx.sessionManager);
    if (!runtime?.feedbackCounters?.checkpointInjected) return;

    const text = extractText(event.message);
    if (!text) return;

    const checkpointTerms = ["checkpoint", "last session", "previously", "was working on", "continued from"];
    const lowerText = text.toLowerCase();
    for (const term of checkpointTerms) {
      if (lowerText.includes(term)) {
        runtime.feedbackCounters.referencesDetected++;
        if (!runtime.feedbackCounters.sectionsReferenced.includes(term)) {
          runtime.feedbackCounters.sectionsReferenced.push(term);
        }
        break;
      }
    }
  });
}
