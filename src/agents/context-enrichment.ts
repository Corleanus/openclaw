import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Checkpoint } from "./context-checkpoint.js";

const log = createSubsystemLogger("context-enrichment");

// ---------- Types ----------

export interface CheckpointEnrichment {
  next_action: string;
  decision_summaries: string[];
  task_status: "in_progress" | "completed" | "blocked" | "waiting_for_user" | "abandoned";
  open_items_refined: string[];
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

  // Token budget: examples add ~100 tokens to the prompt. If prompt + messages
  // gets too large, trim this slice from 20 to 15 to compensate.
  const recentSlice = messages.slice(-20).map((m) => {
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

Produce JSON:
{
  "next_action": "1-2 sentences: what should happen next",
  "decision_summaries": ["1 clean line per decision"],
  "task_status": "in_progress|completed|blocked|waiting_for_user|abandoned",
  "open_items_refined": ["refined list, resolved items removed"]
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

  const nextAction = typeof parsed.next_action === "string" ? parsed.next_action : "";
  const decisionSummaries = Array.isArray(parsed.decision_summaries)
    ? (parsed.decision_summaries as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const taskStatus = typeof parsed.task_status === "string" && VALID_TASK_STATUSES.has(parsed.task_status)
    ? (parsed.task_status as CheckpointEnrichment["task_status"])
    : "";
  const openItemsRefined = Array.isArray(parsed.open_items_refined)
    ? (parsed.open_items_refined as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  if (!nextAction || !taskStatus) {
    log.warn("Enrichment response missing required fields (next_action or task_status)");
    return null;
  }

  return {
    next_action: nextAction,
    decision_summaries: decisionSummaries,
    task_status: taskStatus,
    open_items_refined: openItemsRefined,
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
    { apiKey, maxTokens: 500, signal },
  );

  const text = res.content
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text.trim())
    .join(" ");

  if (!text) return null;
  return parseEnrichmentResponse(text);
}
