import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { completeSimple } from "@mariozechner/pi-ai";
import {
  summarizeInStages,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
} from "../compaction.js";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";

const BRIDGE_KEY = Symbol.for("openclaw.contextManagerBridge");

function getBridge() {
  return (globalThis as any)[BRIDGE_KEY];
}

export default function contextManagerBridge(api: ExtensionAPI): void {
  const bridge = getBridge();
  if (!bridge) return;

  // Inject core utilities the plugin can't import directly
  bridge.utils = {
    summarizeInStages,
    computeAdaptiveChunkRatio,
    estimateMessagesTokens,
    isOversizedForSummary,
    pruneHistoryForContextShare,
    resolveContextWindowTokens,
    BASE_CHUNK_RATIO,
    MIN_CHUNK_RATIO,
    SAFETY_MARGIN,
    SUMMARIZATION_OVERHEAD_TOKENS,
    extractSections,
    createSubsystemLogger,
    enqueueSystemEvent,
    resolveAgentIdFromSessionKey,
    completeSimple,
  };

  api.on("context", async (event, ctx) => getBridge()?.onContext?.(event, ctx));
  api.on("tool_result", async (event, ctx) => {
    return getBridge()?.onToolResult?.(event, ctx);
  });
  api.on("message_end", async (event, ctx) => {
    try { await getBridge()?.onMessageEnd?.(event, ctx); } catch { /* fire-and-forget */ }
  });
  api.on("session_before_compact", async (event, ctx) =>
    getBridge()?.onSessionBeforeCompact?.(event, ctx),
  );
}
