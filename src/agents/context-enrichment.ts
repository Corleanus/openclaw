import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Checkpoint } from "./context-checkpoint.js";

const log = createSubsystemLogger("context-enrichment");

// ---------- Types ----------

export interface CheckpointEnrichment {
  next_action: string;
  decision_summaries: string[];
  task_status?: "in_progress" | "completed" | "blocked" | "waiting_for_user" | "abandoned";
  open_items_refined: string[];
  topic_refined: string;
  thread_summary_refined: string;
  key_exchanges_refined: Array<{ role: "user" | "agent"; gist: string }>;
}

const VALID_TASK_STATUSES = new Set([
  "in_progress",
  "completed",
  "blocked",
  "waiting_for_user",
  "abandoned",
]);

// ---------- Prompt construction ----------

function buildEnrichmentPrompt(
  checkpoint: Checkpoint,
  messages: Array<{ role: string; content: unknown }>,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt =
    "You are a context analyzer. Given a conversation excerpt and checkpoint state, produce a JSON object. Be extremely concise. Output ONLY valid JSON, no markdown fences.";

  const decisions = checkpoint.decisions.map((d) => `- ${d.what}`).join("\n") || "(none)";
  const openItems = checkpoint.open_items.map((i) => `- ${i}`).join("\n") || "(none)";
  const keyExchanges = checkpoint.thread.key_exchanges
    .map((x) => `- ${x.role}: ${x.gist}`)
    .join("\n") || "(none)";

  // Token budget: prompt is richer now, so keep a slightly smaller history slice.
  const recentSlice = messages.slice(-16).map((m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `${m.role}: ${text.slice(0, 300)}`;
  }).join("\n");

  const userPrompt = `<checkpoint>
Topic: ${checkpoint.working.topic}
Status: ${checkpoint.working.status}

Existing decisions:
${decisions}

Open items:
${openItems}

Current thread summary:
${checkpoint.thread.summary}

Current key exchanges:
${keyExchanges}
</checkpoint>

<recent-messages>
${recentSlice}
</recent-messages>

Refine these existing decisions:
- REMOVE entries that are not actual decisions (conversational text, questions, narrative)
- Deduplicate semantically similar entries (keep the cleaner version)
- Clarify wording to be concise, action-oriented statements
- Add any decisions from recent context that are missing
- Keep decisions you cannot verify as resolved — but DO remove entries that are clearly not decisions (e.g., starts with "You're right" or "Ohoho")

An entry is a DECISION if it records: a choice made, an approach selected, a trade-off accepted, or a direction confirmed. Conversational acknowledgments, questions, and narrative descriptions are NOT decisions.

GOOD decisions: "Use atomicWriteFile for checkpoint re-write to bypass dedup", "Merge strategy: LLM decisions + preserved heuristics via set-diff"
BAD (not decisions): "You're right, I overcomplicated it", "- I need to send him a plan", "Ohoho. Claude Code Remote Control"

Also refine conversation metadata:
- topic_refined: short concrete topic line (not a system message, not logs, not prefixes like "System:")
- thread_summary_refined: 1-3 sentence narrative summary of what happened in this session
- key_exchanges_refined: 4-8 entries max, each gist is 1 sentence and never empty
- Rewrite, do not copy truncation artifacts from the checkpoint.

Produce JSON:
{
  "topic_refined": "short topic line",
  "next_action": "1-2 sentences: what the user/agent should do NEXT (forward-looking, not describing past work)",
  "decision_summaries": ["1 clean line per decision"],
  "task_status": "in_progress|completed|blocked|waiting_for_user|abandoned",
  "open_items_refined": ["refined list, resolved items removed"],
  "thread_summary_refined": "narrative summary",
  "key_exchanges_refined": [{"role":"user|agent","gist":"single sentence"}]
}`;

  return { systemPrompt, userPrompt };
}

// ---------- Response parsing ----------

function parseEnrichmentResponse(text: string): CheckpointEnrichment | null {
  const stripped = text
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?```\s*$/m, "");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    log.warn("Failed to parse enrichment response as JSON");
    return null;
  }

  const nextAction = typeof parsed.next_action === "string" ? parsed.next_action.trim() : "";
  const decisionSummaries = Array.isArray(parsed.decision_summaries)
    ? (parsed.decision_summaries as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  const taskStatus = typeof parsed.task_status === "string" && VALID_TASK_STATUSES.has(parsed.task_status)
    ? (parsed.task_status as NonNullable<CheckpointEnrichment["task_status"]>)
    : undefined;
  const openItemsRefined = Array.isArray(parsed.open_items_refined)
    ? (parsed.open_items_refined as unknown[]).filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    : [];
  const topicRefined = typeof parsed.topic_refined === "string" ? parsed.topic_refined.trim() : "";
  const threadSummaryRefined =
    typeof parsed.thread_summary_refined === "string"
      ? parsed.thread_summary_refined.trim()
      : "";
  const keyExchangesRefined = Array.isArray(parsed.key_exchanges_refined)
    ? (parsed.key_exchanges_refined as unknown[])
      .filter((x): x is { role: unknown; gist: unknown } => typeof x === "object" && x !== null)
      .map((x) => ({
        role: x.role === "agent" ? "agent" as const : "user" as const,
        gist: typeof x.gist === "string" ? x.gist.trim() : "",
      }))
      .filter((x) => x.gist.length > 0)
      .slice(0, 8)
    : [];

  // Return partial results — caller applies only non-empty fields individually.
  // Previous all-or-nothing gate lost ALL refinements when a single field was empty.
  const hasAnyContent = topicRefined || nextAction || threadSummaryRefined || taskStatus ||
    decisionSummaries.length > 0 || openItemsRefined.length > 0 || keyExchangesRefined.length > 0;
  if (!hasAnyContent) {
    log.warn("Enrichment response has no usable content");
    return null;
  }

  return {
    topic_refined: topicRefined,
    next_action: nextAction,
    decision_summaries: decisionSummaries,
    task_status: taskStatus,
    open_items_refined: openItemsRefined,
    thread_summary_refined: threadSummaryRefined,
    key_exchanges_refined: keyExchangesRefined,
  };
}

// ---------- Main export ----------

export async function enrichCheckpoint(
  checkpoint: Checkpoint,
  recentMessages: Array<{ role: string; content: unknown }>,
  model: Model<Api>,
  apiKey: string,
  signal: AbortSignal,
): Promise<CheckpointEnrichment | null> {
  const { systemPrompt, userPrompt } = buildEnrichmentPrompt(checkpoint, recentMessages);

  const res = await completeSimple(
    model,
    {
      systemPrompt,
      messages: [
        { role: "user" as const, content: userPrompt, timestamp: Date.now() },
      ],
    },
    { apiKey, maxTokens: 800, signal },
  );

  const text = res.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text.trim())
    .join(" ");

  if (!text) return null;
  return parseEnrichmentResponse(text);
}
