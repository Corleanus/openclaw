import fs from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, FileOperations } from "@mariozechner/pi-coding-agent";
import { extractSections } from "../../auto-reply/reply/post-compaction-context.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
  SUMMARIZATION_OVERHEAD_TOKENS,
  computeAdaptiveChunkRatio,
  estimateMessagesTokens,
  isOversizedForSummary,
  pruneHistoryForContextShare,
  resolveContextWindowTokens,
  summarizeInStages,
} from "../compaction.js";
import { writeCheckpoint, pruneOldCheckpoints, readLatestCheckpoint, atomicWriteFile } from "../context-checkpoint.js";
import { enrichCheckpoint } from "../context-enrichment.js";
import { calculateUtilization } from "../context-gauge.js";
import { promoteLearningsToCrossSession } from "../context-learnings.js";
import { readStateFiles, resetStateFiles, readLastToolCallFromState } from "../context-state.js";
import { collectTextContentBlocks } from "../content-blocks.js";
import { buildCheckpointFromState } from "./context-manager.js";
import { getContextManagerRuntime } from "./context-manager-runtime.js";
import { getCompactionSafeguardRuntime } from "./compaction-safeguard-runtime.js";
import { isSemanticDuplicate } from "../../agents/context-dedup.js";

const log = createSubsystemLogger("compaction-safeguard");
const FALLBACK_SUMMARY =
  "Summary unavailable due to context limits. Older messages were truncated.";
const TURN_PREFIX_INSTRUCTIONS =
  "This summary covers the prefix of a split turn. Focus on the original request," +
  " early progress, and any details needed to understand the retained suffix.";
const MAX_TOOL_FAILURES = 8;
const MAX_TOOL_FAILURE_CHARS = 240;
const MAX_TOPIC_CHARS = 200;
const MAX_THREAD_SUMMARY_CHARS = 600;
const MAX_GIST_CHARS = 200;

type ToolFailure = {
  toolCallId: string;
  toolName: string;
  summary: string;
  meta?: string;
};

function normalizeFailureText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFailureText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function formatToolFailureMeta(details: unknown): string | undefined {
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record = details as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status : undefined;
  const exitCode =
    typeof record.exitCode === "number" && Number.isFinite(record.exitCode)
      ? record.exitCode
      : undefined;
  const parts: string[] = [];
  if (status) {
    parts.push(`status=${status}`);
  }
  if (exitCode !== undefined) {
    parts.push(`exitCode=${exitCode}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractToolResultText(content: unknown): string {
  return collectTextContentBlocks(content).join("\n");
}

function collectToolFailures(messages: AgentMessage[]): ToolFailure[] {
  const failures: ToolFailure[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "toolResult") {
      continue;
    }
    const toolResult = message as {
      toolCallId?: unknown;
      toolName?: unknown;
      content?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (toolResult.isError !== true) {
      continue;
    }
    const toolCallId = typeof toolResult.toolCallId === "string" ? toolResult.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) {
      continue;
    }
    seen.add(toolCallId);

    const toolName =
      typeof toolResult.toolName === "string" && toolResult.toolName.trim()
        ? toolResult.toolName
        : "tool";
    const rawText = extractToolResultText(toolResult.content);
    const meta = formatToolFailureMeta(toolResult.details);
    const normalized = normalizeFailureText(rawText);
    const summary = truncateFailureText(
      normalized || (meta ? "failed" : "failed (no output)"),
      MAX_TOOL_FAILURE_CHARS,
    );
    failures.push({ toolCallId, toolName, summary, meta });
  }

  return failures;
}

function formatToolFailuresSection(failures: ToolFailure[]): string {
  if (failures.length === 0) {
    return "";
  }
  const lines = failures.slice(0, MAX_TOOL_FAILURES).map((failure) => {
    const meta = failure.meta ? ` (${failure.meta})` : "";
    return `- ${failure.toolName}${meta}: ${failure.summary}`;
  });
  if (failures.length > MAX_TOOL_FAILURES) {
    lines.push(`- ...and ${failures.length - MAX_TOOL_FAILURES} more`);
  }
  return `\n\n## Tool Failures\n${lines.join("\n")}`;
}

function computeFileLists(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((f) => !modified.has(f)).toSorted();
  const modifiedFiles = [...modified].toSorted();
  return { readFiles, modifiedFiles };
}

function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) {
    sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  }
  if (modifiedFiles.length > 0) {
    sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (sections.length === 0) {
    return "";
  }
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Read and format critical workspace context for compaction summary.
 * Extracts "Session Startup" and "Red Lines" from AGENTS.md.
 * Limited to 2000 chars to avoid bloating the summary.
 */
async function readWorkspaceContextForSummary(): Promise<string> {
  const MAX_SUMMARY_CONTEXT_CHARS = 2000;
  const workspaceDir = process.cwd();
  const agentsPath = path.join(workspaceDir, "AGENTS.md");

  try {
    if (!fs.existsSync(agentsPath)) {
      return "";
    }

    const content = await fs.promises.readFile(agentsPath, "utf-8");
    const sections = extractSections(content, ["Session Startup", "Red Lines"]);

    if (sections.length === 0) {
      return "";
    }

    const combined = sections.join("\n\n");
    const safeContent =
      combined.length > MAX_SUMMARY_CONTEXT_CHARS
        ? combined.slice(0, MAX_SUMMARY_CONTEXT_CHARS) + "\n...[truncated]..."
        : combined;

    return `\n\n<workspace-critical-rules>\n${safeContent}\n</workspace-critical-rules>`;
  } catch {
    return "";
  }
}

export default function compactionSafeguardExtension(api: ExtensionAPI): void {
  api.on("session_before_compact", async (event, ctx) => {
    const { preparation, customInstructions, signal } = event;
    const { readFiles, modifiedFiles } = computeFileLists(preparation.fileOps);
    const fileOpsSummary = formatFileOperations(readFiles, modifiedFiles);
    const toolFailures = collectToolFailures([
      ...preparation.messagesToSummarize,
      ...preparation.turnPrefixMessages,
    ]);
    const toolFailureSection = formatToolFailuresSection(toolFailures);
    const fallbackSummary = `${FALLBACK_SUMMARY}${toolFailureSection}${fileOpsSummary}`;

    // --- Context Manager: write checkpoint (mechanical, no LLM needed) ---
    let cmRuntime: ReturnType<typeof getContextManagerRuntime> = null;
    let stateFiles: Awaited<ReturnType<typeof readStateFiles>> | undefined;
    let cpMessages: AgentMessage[] | undefined;
    let checkpoint: Awaited<ReturnType<typeof buildCheckpointFromState>> | undefined;
    let cpResult: Awaited<ReturnType<typeof writeCheckpoint>> | undefined;
    let latestCp: Awaited<ReturnType<typeof readLatestCheckpoint>> | undefined;
    try {
      cmRuntime = getContextManagerRuntime(ctx.sessionManager);
      if (cmRuntime) {
        stateFiles = await readStateFiles(cmRuntime.stateDir, cmRuntime.sessionKey);
        const usage = ctx.getContextUsage();
        const gauge = calculateUtilization(usage, cmRuntime.contextWindowTokens);
        // Combine both arrays: messagesToSummarize has early history,
        // turnPrefixMessages has the current turn's prefix (on split turns).
        // Both contain user/assistant messages needed for topic/thread extraction.
        cpMessages = [
          ...(preparation.messagesToSummarize ?? []),
          ...(preparation.turnPrefixMessages ?? []),
        ];
        latestCp = await readLatestCheckpoint(cmRuntime.stateDir, cmRuntime.sessionKey);
        const prevCount = latestCp?.meta?.compaction_count ?? 0;
        // Always read state file — runtime may be empty if tool_result hasn't fired yet
        const persistedToolCall = await readLastToolCallFromState(cmRuntime.stateDir, cmRuntime.sessionKey);
        if (!cmRuntime.lastToolCall && persistedToolCall) {
          cmRuntime.lastToolCall = persistedToolCall;
        }
        if (!cmRuntime.lastToolCall) {
          log.debug("lastToolCall is null at compaction — no tool_result events captured this session segment");
        }
        checkpoint = buildCheckpointFromState(
          stateFiles,
          gauge,
          cpMessages,
          cmRuntime,
          "compaction",
          { isSplitTurn: preparation.isSplitTurn, fileOps: preparation.fileOps, compactionCount: prevCount + 1 },
        );
        cpResult = await writeCheckpoint(cmRuntime.stateDir, cmRuntime.sessionKey, checkpoint);
        if (cpResult.written) {
          await pruneOldCheckpoints(cmRuntime.stateDir, cmRuntime.sessionKey);
        }
      }
    } catch (cpError) {
      log.warn(
        `Context checkpoint write failed during compaction: ${
          cpError instanceof Error ? cpError.message : String(cpError)
        }`,
      );
    }
    // --- End Context Manager checkpoint ---

    const model = ctx.model;
    if (!model) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    const apiKey = await ctx.modelRegistry.getApiKey(model);
    if (!apiKey) {
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }

    try {
      // Enrichment: LLM-enhance the checkpoint if it was written
      if (cpResult?.written && cmRuntime && checkpoint) {
        try {
          const enrichmentMessages = (cpMessages ?? []).map((m) => ({
            role: "role" in m ? String(m.role) : "unknown",
            content: "content" in m ? m.content : undefined,
          }));
          const enrichment = await enrichCheckpoint(checkpoint, enrichmentMessages, model, apiKey, signal);
          if (enrichment) {
            // Apply each field independently — partial enrichment is better than none
            let fieldsApplied = 0;
            if (enrichment.topic_refined) {
              checkpoint.working.topic = truncateText(enrichment.topic_refined, MAX_TOPIC_CHARS);
              fieldsApplied++;
            }
            if (enrichment.next_action) {
              checkpoint.working.next_action = enrichment.next_action;
              fieldsApplied++;
            }
            if (enrichment.task_status) {
              checkpoint.working.status = enrichment.task_status;
              fieldsApplied++;
            }
            if (enrichment.thread_summary_refined) {
              checkpoint.thread.summary = truncateText(
                enrichment.thread_summary_refined,
                MAX_THREAD_SUMMARY_CHARS,
              );
              fieldsApplied++;
            }
            if (enrichment.key_exchanges_refined.length > 0) {
              checkpoint.thread.key_exchanges = enrichment.key_exchanges_refined
                .map((x) => ({ role: x.role, gist: truncateText(x.gist, MAX_GIST_CHARS) }))
                .filter((x) => x.gist.trim().length > 0)
                .slice(0, 8);
              fieldsApplied++;
            }
            if (enrichment.decision_summaries.length > 0) {
              const llmDecisions = enrichment.decision_summaries;
              const heuristicDecisions = checkpoint.decisions.map(d => d.what);
              const preserved = heuristicDecisions.filter(hd =>
                !llmDecisions.some(ld => isSemanticDuplicate(hd, ld))
              );
              const merged = [...llmDecisions, ...preserved];
              // Dedup within final decisions list — LLM may produce internal near-duplicates
              const dedupedDecisions: string[] = [];
              for (const d of merged) {
                if (!dedupedDecisions.some(existing => isSemanticDuplicate(existing, d))) {
                  dedupedDecisions.push(d);
                }
              }
              checkpoint.decisions = dedupedDecisions.map((d, i) => ({
                id: `d${i + 1}`, what: d, when: checkpoint!.meta.created_at,
              }));
              fieldsApplied++;
            }
            if (enrichment.open_items_refined.length > 0) {
              const llmItems = enrichment.open_items_refined;
              const preservedItems = checkpoint.open_items.filter(hi =>
                !llmItems.some(li => isSemanticDuplicate(hi, li))
              );
              checkpoint.open_items = [...llmItems, ...preservedItems];
              fieldsApplied++;
            }
            // Dedup within final open_items list — LLM may produce internal near-duplicates
            const dedupedItems: string[] = [];
            for (const item of checkpoint.open_items) {
              if (!dedupedItems.some(existing => isSemanticDuplicate(existing, item))) {
                dedupedItems.push(item);
              }
            }
            checkpoint.open_items = dedupedItems;
            // Only mark as LLM-enriched if at least one field was actually applied
            if (fieldsApplied > 0) {
              checkpoint.meta.enrichment = "llm";
            }
            // Re-write YAML directly (bypass writeCheckpoint dedup)
            const { stringify } = await import("yaml");
            await atomicWriteFile(cpResult.path, stringify(checkpoint));
          }
        } catch (enrichError) {
          log.warn(`LLM enrichment failed, keeping heuristic checkpoint: ${enrichError instanceof Error ? enrichError.message : String(enrichError)}`);
        }
      }

      // Learning promotion: persist cross-session learnings before state reset
      if (stateFiles?.learnings && stateFiles.learnings.length > 0 && cmRuntime && checkpoint) {
        const effectiveCheckpointId = cpResult?.written
          ? checkpoint.meta.checkpoint_id
          : (latestCp?.meta?.checkpoint_id ?? checkpoint.meta.checkpoint_id);
        try {
          await promoteLearningsToCrossSession(
            cmRuntime.stateDir,
            cmRuntime.sessionKey,
            stateFiles.learnings,
            effectiveCheckpointId,
          );
        } catch (promoError) {
          log.warn(`Learning promotion failed: ${promoError instanceof Error ? promoError.message : String(promoError)}`);
        }
      }

      // Reset state files after checkpoint + enrichment + promotion
      if (cpResult?.written && cmRuntime) {
        await resetStateFiles(cmRuntime.stateDir, cmRuntime.sessionKey);
      }

      const runtime = getCompactionSafeguardRuntime(ctx.sessionManager);
      const modelContextWindow = resolveContextWindowTokens(model);
      const contextWindowTokens = runtime?.contextWindowTokens ?? modelContextWindow;
      const turnPrefixMessages = preparation.turnPrefixMessages ?? [];
      let messagesToSummarize = preparation.messagesToSummarize;

      const maxHistoryShare = runtime?.maxHistoryShare ?? 0.5;

      const tokensBefore =
        typeof preparation.tokensBefore === "number" && Number.isFinite(preparation.tokensBefore)
          ? preparation.tokensBefore
          : undefined;

      let droppedSummary: string | undefined;

      if (tokensBefore !== undefined) {
        const summarizableTokens =
          estimateMessagesTokens(messagesToSummarize) + estimateMessagesTokens(turnPrefixMessages);
        const newContentTokens = Math.max(0, Math.floor(tokensBefore - summarizableTokens));
        // Apply SAFETY_MARGIN so token underestimates don't trigger unnecessary pruning
        const maxHistoryTokens = Math.floor(contextWindowTokens * maxHistoryShare * SAFETY_MARGIN);

        if (newContentTokens > maxHistoryTokens) {
          const pruned = pruneHistoryForContextShare({
            messages: messagesToSummarize,
            maxContextTokens: contextWindowTokens,
            maxHistoryShare,
            parts: 2,
          });
          if (pruned.droppedChunks > 0) {
            const newContentRatio = (newContentTokens / contextWindowTokens) * 100;
            log.warn(
              `Compaction safeguard: new content uses ${newContentRatio.toFixed(
                1,
              )}% of context; dropped ${pruned.droppedChunks} older chunk(s) ` +
                `(${pruned.droppedMessages} messages) to fit history budget.`,
            );
            messagesToSummarize = pruned.messages;

            // Summarize dropped messages so context isn't lost
            if (pruned.droppedMessagesList.length > 0) {
              try {
                const droppedChunkRatio = computeAdaptiveChunkRatio(
                  pruned.droppedMessagesList,
                  contextWindowTokens,
                );
                const droppedMaxChunkTokens = Math.max(
                  1,
                  Math.floor(contextWindowTokens * droppedChunkRatio) -
                    SUMMARIZATION_OVERHEAD_TOKENS,
                );
                droppedSummary = await summarizeInStages({
                  messages: pruned.droppedMessagesList,
                  model,
                  apiKey,
                  signal,
                  reserveTokens: Math.max(1, Math.floor(preparation.settings.reserveTokens)),
                  maxChunkTokens: droppedMaxChunkTokens,
                  contextWindow: contextWindowTokens,
                  customInstructions,
                  previousSummary: preparation.previousSummary,
                });
              } catch (droppedError) {
                log.warn(
                  `Compaction safeguard: failed to summarize dropped messages, continuing without: ${
                    droppedError instanceof Error ? droppedError.message : String(droppedError)
                  }`,
                );
              }
            }
          }
        }
      }

      // Use adaptive chunk ratio based on message sizes, reserving headroom for
      // the summarization prompt, system prompt, previous summary, and reasoning budget
      // that generateSummary adds on top of the serialized conversation chunk.
      const allMessages = [...messagesToSummarize, ...turnPrefixMessages];
      const adaptiveRatio = computeAdaptiveChunkRatio(allMessages, contextWindowTokens);
      const maxChunkTokens = Math.max(
        1,
        Math.floor(contextWindowTokens * adaptiveRatio) - SUMMARIZATION_OVERHEAD_TOKENS,
      );
      const reserveTokens = Math.max(1, Math.floor(preparation.settings.reserveTokens));

      // Feed dropped-messages summary as previousSummary so the main summarization
      // incorporates context from pruned messages instead of losing it entirely.
      const effectivePreviousSummary = droppedSummary ?? preparation.previousSummary;

      const historySummary = await summarizeInStages({
        messages: messagesToSummarize,
        model,
        apiKey,
        signal,
        reserveTokens,
        maxChunkTokens,
        contextWindow: contextWindowTokens,
        customInstructions,
        previousSummary: effectivePreviousSummary,
      });

      let summary = historySummary;
      if (preparation.isSplitTurn && turnPrefixMessages.length > 0) {
        const prefixSummary = await summarizeInStages({
          messages: turnPrefixMessages,
          model,
          apiKey,
          signal,
          reserveTokens,
          maxChunkTokens,
          contextWindow: contextWindowTokens,
          customInstructions: TURN_PREFIX_INSTRUCTIONS,
          previousSummary: undefined,
        });
        summary = `${historySummary}\n\n---\n\n**Turn Context (split turn):**\n\n${prefixSummary}`;
      }

      summary += toolFailureSection;
      summary += fileOpsSummary;

      // Append workspace critical context (Session Startup + Red Lines from AGENTS.md)
      const workspaceContext = await readWorkspaceContextForSummary();
      if (workspaceContext) {
        summary += workspaceContext;
      }

      return {
        compaction: {
          summary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    } catch (error) {
      log.warn(
        `Compaction summarization failed; truncating history: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        compaction: {
          summary: fallbackSummary,
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          details: { readFiles, modifiedFiles },
        },
      };
    }
  });
}

export const __testing = {
  collectToolFailures,
  formatToolFailuresSection,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} as const;
