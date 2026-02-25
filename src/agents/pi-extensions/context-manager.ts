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
  writeLastToolCallToState,
  writeThreadSnapshot,
  readThreadSnapshot,
} from "../context-state.js";
import type { StateFiles, ThreadSnapshot } from "../context-state.js";
import { readCheckpointForInjection } from "../context-checkpoint-inject.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";

const log = createSubsystemLogger("context-manager");

// ---------- Session-scoped tracking ----------

const initializedSessions = new Set<string>();
const resumeInjected = new Set<string>();

// ---------- Helper functions ----------

function findLastUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRealUserMessage(messages[i])) return messages[i];
  }
  return undefined;
}

function findFirstUserMessage(messages: AgentMessage[]): AgentMessage | undefined {
  for (const msg of messages) {
    if (isRealUserMessage(msg)) return msg;
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
  const firstText = first ? truncate(extractText(first).trim(), 100) : "";
  const lastText = last ? truncate(extractText(last).trim(), 100) : "";
  if (firstText && lastText && first !== last) {
    return `Session started with: ${firstText}. Latest user focus: ${lastText}.`;
  }
  if (lastText) {
    return `Latest user focus: ${lastText}.`;
  }
  if (firstText) {
    return `Session topic: ${firstText}.`;
  }
  return "No conversation context";
}

function buildKeyExchanges(
  messages: AgentMessage[],
): Array<{ role: "user" | "agent"; gist: string }> {
  const toGist = (message: AgentMessage, role: "user" | "agent"): string => {
    const text = truncate(extractText(message).trim(), 120);
    if (text.length > 0) return text;
    return role === "user" ? "[user message without text]" : "[assistant message without text]";
  };

  const pushExchange = (
    target: Array<{ role: "user" | "agent"; gist: string }>,
    role: "user" | "agent",
    gist: string,
  ): void => {
    if (!gist.trim()) return;
    target.push({ role, gist });
  };

  const exchanges: Array<{ role: "user" | "agent"; gist: string }> = [];
  const userAgentPairs: Array<{ user: AgentMessage; agent?: AgentMessage }> = [];

  // Collect user-agent pairs — scan forward past custom/toolResult messages
  // to find the next assistant message after each user message
  for (let i = 0; i < messages.length; i++) {
    if (!isRealUserMessage(messages[i])) continue;
    let agent: AgentMessage | undefined;
    for (let j = i + 1; j < messages.length; j++) {
      const candidate = messages[j] as { role?: string };
      if (candidate?.role === "assistant") {
        agent = messages[j];
        break;
      }
      // Stop scanning if we hit the next real user message
      if (isRealUserMessage(messages[j])) break;
    }
    userAgentPairs.push({ user: messages[i], agent });
  }

  if (userAgentPairs.length === 0) return [];

  // Always include first
  const first = userAgentPairs[0];
  pushExchange(exchanges, "user", toGist(first.user, "user"));
  if (first.agent) {
    pushExchange(exchanges, "agent", toGist(first.agent, "agent"));
  }

  // Middle pairs: evenly sample up to 3 pairs to capture the conversation arc
  if (userAgentPairs.length > 3) {
    const middleStart = 1;
    const middleEnd = userAgentPairs.length - 2;
    const middleCount = middleEnd - middleStart;
    const maxMiddle = 3;
    const step = Math.max(1, Math.ceil(middleCount / maxMiddle));
    for (let i = middleStart; i < middleEnd; i += step) {
      const pair = userAgentPairs[i];
      pushExchange(exchanges, "user", toGist(pair.user, "user"));
      if (pair.agent) {
        pushExchange(exchanges, "agent", toGist(pair.agent, "agent"));
      }
    }
  }

  // Always include last 2 pairs
  const lastPairs = userAgentPairs.slice(-2);
  for (const pair of lastPairs) {
    if (pair === first) continue; // Skip if already included
    pushExchange(exchanges, "user", toGist(pair.user, "user"));
    if (pair.agent) {
      pushExchange(exchanges, "agent", toGist(pair.agent, "agent"));
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

// ---------- Decision extraction ----------

const ACTION_VERBS = new Set([
  "use", "add", "remove", "replace", "create", "implement", "switch", "move",
  "keep", "skip", "merge", "split", "export", "import", "change", "fix",
  "update", "deploy", "persist", "store", "read", "write", "inject", "filter",
  "track", "chose", "decided",
]);

const FILLER_RE = /^(you're right|ohoho|haha|hmm|well,|okay so|sure,|yeah|ok |ah |oh )/i;

function hasActionVerb(text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).slice(0, 10);
  return words.some((w) => ACTION_VERBS.has(w.replace(/[^a-z]/g, "")));
}

function hasStructuralMarker(text: string): boolean {
  return /\*\*/.test(text) || /^[-*]\s/.test(text) || /^\d+\.\s/.test(text) || /:\s/.test(text);
}

function passesQualityGate(text: string): boolean {
  if (FILLER_RE.test(text)) return false;
  if (text.trimEnd().endsWith("?")) return false;
  if (!hasActionVerb(text) && !hasStructuralMarker(text)) return false;
  return true;
}

function extractDecisionFromResponse(text: string): string | null {
  const lines = text.split("\n");
  let inCodeFence = false;

  const candidates: Array<{ tier: number; line: string }> = [];

  for (const raw of lines) {
    const line = raw.trimStart();
    if (line.startsWith("```")) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;
    if (!line) continue;

    // Tier 1: Explicit decision markers
    if (/^(Decision:|Plan:|Approach:|Going with|Chose|Choosing)/i.test(line)) {
      candidates.push({ tier: 1, line: raw.trim() });
      continue;
    }

    // Tier 2: Action intent
    if (
      /^(I'll|We'll|Let's|I will|We will|I'm going to|We're going to)/i.test(line) ||
      /^(The approach is|The plan is|The fix is|The solution is)/i.test(line)
    ) {
      candidates.push({ tier: 2, line: raw.trim() });
      continue;
    }

    // Tier 3: Structured formats — bold heading (with action verb) or bold-prefixed bullet
    if (/^[-*]\s+\*\*[^*]+\*\*/.test(line)) {
      candidates.push({ tier: 3, line: raw.trim() });
      continue;
    }
    if (line.startsWith("**") && hasActionVerb(line)) {
      candidates.push({ tier: 3, line: raw.trim() });
      continue;
    }

    // Tier 4: Action-verb bullets (plain bullets or numbered)
    if (/^[-*]\s/.test(line) || /^\d+\.\s/.test(line)) {
      const words = line.split(/\s+/).slice(0, 5);
      if (words.some((w) => ACTION_VERBS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) {
        candidates.push({ tier: 4, line: raw.trim() });
      }
    }
  }

  // Pick highest tier (lowest number), first match within tier
  candidates.sort((a, b) => a.tier - b.tier);

  for (const c of candidates) {
    if (passesQualityGate(c.line)) {
      return truncate(c.line, 200);
    }
  }

  return null;
}

// ---------- System message filtering ----------

function isRealUserMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: string })?.role;
  if (role !== "user") return false;
  const text = extractText(msg);
  const trimmed = text.trimStart();
  if (text.includes("<checkpoint-data")) return false;
  if (text.includes("schema: openclaw/checkpoint")) return false;
  if (trimmed.startsWith("Summary unavailable") || trimmed.startsWith("This summary covers")) return false;
  if (trimmed.startsWith("Token utilization:") || trimmed.startsWith("## Token Gauge")) return false;
  // System-injected lines (e.g., from hooks or extensions)
  if (trimmed.startsWith("System:")) return false;
  // Cron/injected payloads can be embedded in user-role content, often with timestamp prefixes.
  // Prefix semantics: optional [bracketed] groups then [System Message] followed by whitespace or end.
  if (/^\s*(?:\[[^\]]+\]\s*)*\[System Message\](?=\s|$)/i.test(trimmed)) return false;
  return true;
}

// ---------- Exported checkpoint builder ----------

export function buildCheckpointFromState(
  stateFiles: StateFiles,
  gauge: GaugeResult,
  messages: AgentMessage[],
  runtime: ContextManagerRuntimeValue,
  trigger: CheckpointTrigger,
  options?: { isSplitTurn?: boolean; fileOps?: FileOperations; compactionCount?: number; threadSnapshot?: ThreadSnapshot | null },
): Checkpoint {
  // Extract topic: prefer snapshot (built from full message history) over cpMessages (partial at compaction)
  const lastUserMsg = findLastUserMessage(messages);
  const msgTopic = lastUserMsg ? truncate(extractText(lastUserMsg), 200) : "";
  const topic = options?.threadSnapshot?.topic || msgTopic || "Unknown topic";

  // Build thread: prefer snapshot over cpMessages-based extraction
  const firstUserMsg = findFirstUserMessage(messages);
  const msgSummary = buildThreadSummary(firstUserMsg, lastUserMsg);
  const threadSummary = options?.threadSnapshot?.summary || msgSummary;

  const msgExchanges = buildKeyExchanges(messages);
  const keyExchanges = (options?.threadSnapshot?.key_exchanges?.length ?? 0) > 0
    ? options!.threadSnapshot!.key_exchanges
    : msgExchanges;

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
      // Decision capture: detect short user confirmation after long agent response,
      // then extract a meaningful decision line from the agent text
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
          const isShortConfirmation = userText.length < 15 && !userText.trim().endsWith("?");
          const hasConfirmKeyword = /\b(yes|no|go|do it|ship it|pick|approve|proceed|let's go|sounds good|go ahead|implement|fix|ok|okay|sure|agreed|confirm|da|ja|oui|si|sim|vai)\b/i.test(userText);
          if (
            agentText.length > 0 &&
            userText.length < 50 &&
            agentText.length > 500 &&
            (isShortConfirmation || hasConfirmKeyword)
          ) {
            const decision = extractDecisionFromResponse(agentText);
            if (decision) {
              await appendDecisionToState(runtime.stateDir, runtime.sessionKey, {
                what: decision,
                when: new Date().toISOString(),
              });
            }
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
                const trimmed = truncate(line.trim(), 500);
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

    // Thread snapshot: continuously update topic/summary/key_exchanges from full message history.
    // At compaction time, preparation.messagesToSummarize only has DROPPED messages (not kept ones),
    // so the checkpoint builder would miss recent user messages. This snapshot captures the full view.
    try {
      const allMessages = captureMessages;
      const snapLastUser = findLastUserMessage(allMessages);
      const snapFirstUser = findFirstUserMessage(allMessages);
      const snapTopic = snapLastUser ? truncate(extractText(snapLastUser), 200) : "";
      const snapSummary = buildThreadSummary(snapFirstUser, snapLastUser);
      if (snapTopic) {
        await writeThreadSnapshot(runtime.stateDir, runtime.sessionKey, {
          topic: snapTopic,
          summary: snapSummary,
          key_exchanges: buildKeyExchanges(allMessages),
          updated_at: new Date().toISOString(),
        });
      }
    } catch (err) {
      log.warn(`Thread snapshot write failed: ${err instanceof Error ? err.message : String(err)}`);
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

    // Persist before continuing so compaction cannot observe a stale/null file.
    await writeLastToolCallToState(runtime.stateDir, runtime.sessionKey, runtime.lastToolCall).catch((e) =>
      log.warn?.(`Failed to persist lastToolCall: ${e instanceof Error ? e.message : String(e)}`)
    );

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

export const __testing = {
  extractDecisionFromResponse,
  isRealUserMessage,
  passesQualityGate,
  hasActionVerb,
} as const;
