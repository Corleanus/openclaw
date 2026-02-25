# Context Manager v4 — Checkpoint Quality Spec

## Context

v2 pipeline works: mechanical write → LLM enrichment → merge → re-write. Production testing (2026-02-25) confirmed the architecture is sound but exposed 4 quality issues in heuristic capture and merge logic. This spec fixes those and adds improvements for A+ checkpoint quality.

**Reviewed by Codex (R1):** 10 findings (2 BLOCKERs, 4 GAPs, 2 RISKs, 1 NIT, 1 test coverage GAP). All incorporated below.

---

## Issue 1: Decision Capture Captures Noise

### Problem
Decision heuristic (`context-manager.ts:343-377`) detects "short user confirmation after long agent response" and captures `truncate(agentText, 200)` — the raw first 200 chars of the agent response. When the response starts with conversational text ("You're right, I overcomplicated it..." or "Ohoho. Claude Code Remote Control"), that verbatim garbage becomes a "decision."

LLM enrichment produces clean decisions (d1-d5) but the merge safety net preserves these garbage heuristic entries (d6-d9) because fingerprint dedup can't match "You're right, I overcomplicated it" against "Simplified enrichment merge to use lowercase set-diff."

### Root Cause
`truncate(agentText, 200)` is not a decision — it's the start of a response that *contains* a decision somewhere within it.

### Fix

**A. Extract decision from agent response instead of truncating it.**

Replace the capture logic in `context-manager.ts`:

```typescript
// Current (broken):
await appendDecisionToState(runtime.stateDir, runtime.sessionKey, {
  what: truncate(agentText, 200),
  when: new Date().toISOString(),
});

// Fixed:
const decision = extractDecisionFromResponse(agentText);
if (decision) {
  await appendDecisionToState(runtime.stateDir, runtime.sessionKey, {
    what: decision,
    when: new Date().toISOString(),
  });
}
```

**New function `extractDecisionFromResponse(text: string): string | null`:**

1. Split response into lines
2. Skip lines inside code fences
3. Look for decision-indicator patterns (in priority order — Codex R1 #4: concrete regexes):
   - **Tier 1 — Explicit decision markers:**
     - Lines matching `/^(Decision:|Plan:|Approach:|Going with|Chose|Choosing)/i`
   - **Tier 2 — Action intent statements:**
     - Lines matching `/^(I'll|We'll|Let's|I will|We will|I'm going to|We're going to)/i`
     - Lines matching `/^(The approach is|The plan is|The fix is|The solution is)/i`
   - **Tier 3 — Structured decision formats:**
     - Lines starting with `**` (bold heading — typically the decision summary)
     - Lines matching `/^[-*]\s+\*\*[^*]+\*\*/` (bold-prefixed bullet — common decision format)
   - **Tier 4 — Action-verb bullets** (fallback):
     - Plain bullets (`/^[-*]\s/`) or numbered items (`/^\d+\.\s/`) containing action verbs from the lexicon (see quality gate below)
     - Rank by verb position — prefer lines where verb appears in first 5 words
4. If multiple matches, take the highest-tier match (within same tier, take first occurrence)
5. If no match at any tier, return `null` (skip capture — no decision is better than noise)
6. Truncate result to 200 chars

**B. Add a minimum quality gate for captured decisions:**
- Reject if captured text starts with conversational filler: `/^(you're right|ohoho|haha|hmm|well,|okay so|sure,|yeah|ok |ah |oh )/i`
- Reject if captured text is a question (ends with `?`)
- **Structural check** (replaces brittle `[A-Z_]` heuristic — Codex R1 #3):
  - Reject if text has no action verbs AND no structural markers (bold, bullet, colon-separated key-value)
  - Action verb lexicon: `use`, `add`, `remove`, `replace`, `create`, `implement`, `switch`, `move`, `keep`, `skip`, `merge`, `split`, `export`, `import`, `change`, `fix`, `update`, `deploy`, `persist`, `store`, `read`, `write`, `inject`, `filter`, `track`, `chose`, `going with`, `decided`
  - A line passes if: contains >= 1 action verb OR starts with `**` OR matches `/^[-*]\s/` (bullet) OR contains `:` after a keyword
  - Fallback: if none of the above, return `null` (skip capture)

### Files
- `src/agents/pi-extensions/context-manager.ts` — replace decision capture block, add `extractDecisionFromResponse`

---

## Issue 2: Merge Dedup Is Too Literal

### Problem
The merge in `compaction-safeguard.ts:290-304` uses exact lowercase string matching:
```typescript
const llmLower = new Set(llmDecisions.map(d => d.toLowerCase().trim()));
const preserved = heuristicDecisions.filter(d => !llmLower.has(d.toLowerCase().trim()));
```

"Send Grigorije a plan" vs "- I need to send him a plan" both survive because they're different strings. Same issue for open items.

### Root Cause
Exact match can't detect semantic overlap. Need fuzzy matching.

### Fix

**New function `isSemanticDuplicate(a: string, b: string): boolean`:**

**Short-circuit** (Codex R1 #8 — NIT): Before the 3-tier check, do a cheap normalized equality precheck. Normalize both strings (strip bullets, strip markdown, collapse whitespace, lowercase) and compare. If equal → return true immediately. Cache tokenized keyword forms if the function is called in a loop (e.g., `O(n*m)` merge comparisons).

Three-tier matching (any tier match = duplicate):

1. **Normalized exact match** (cheap, catches formatting diffs):
   - Strip leading bullets (`- `, `* `, `1. `)
   - Strip markdown formatting (`**`, `*`, `` ` ``)
   - Collapse whitespace
   - Compare

2. **Keyword overlap** (catches rephrasing):
   - Extract keywords: split on whitespace, lowercase, remove stop words (see list below — includes English + Serbian)
   - Filter to words >= 3 chars
   - **Cardinality guard** (Codex R1 #5): If `|union| < 3`, skip Jaccard — too few keywords for meaningful comparison. Fall through to tier 3.
   - Compute Jaccard similarity: `|intersection| / |union|`
   - Threshold: >= 0.5 → duplicate

3. **Substring containment** (catches abbreviated vs full):
   - After normalization from tier 1, if shorter string (>= 10 chars) is a substring of longer → duplicate

**Apply `isSemanticDuplicate` in the merge step** for both decisions and open items:

```typescript
// Replace exact match:
const preserved = heuristicDecisions.filter(hd =>
  !llmDecisions.some(ld => isSemanticDuplicate(hd, ld))
);
```

### Stop Word List
Keep it small and focused. Function words that don't carry semantic meaning for decision/item comparison. **Multilingual** (Codex R1 #6): English + Serbian — the two primary languages in this system's conversations.

```typescript
const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "to", "and", "or", "in", "for", "with", "that", "this", "of",
  "i", "we", "it", "he", "she", "they", "you", "my", "our",
  "need", "should", "will", "must", "have", "has", "had",
  "do", "does", "did", "can", "could", "would",
  "not", "no", "but", "if", "so", "then",
  // Serbian (Latin script — most common in technical context)
  "je", "su", "sam", "si", "smo", "ste",     // to be
  "i", "ili", "ali", "a", "da", "ne",         // conjunctions/particles
  "za", "na", "u", "sa", "od", "do", "iz",    // prepositions
  "taj", "ta", "to", "ovo", "ono",            // demonstratives
  "ja", "ti", "on", "ona", "mi", "vi", "oni", // pronouns
  "treba", "moze", "mora", "ce",              // modals
]);
```

### Files
- `src/agents/pi-extensions/compaction-safeguard.ts` — replace literal dedup with `isSemanticDuplicate` in both decision and open_items merge blocks
- `src/agents/context-dedup.ts` (NEW) — **pure utility module** (Codex R1 #9): exports `isSemanticDuplicate`, `normalize`, `extractKeywords`, `STOP_WORDS`. Zero imports from context-state, compaction-safeguard, context-enrichment, or any pi-extension module. Only stdlib/string utilities allowed. This prevents circular dependency chains.

---

## Issue 3: Thread Summary Includes System Messages

### Problem
`buildThreadSummary` in `context-manager.ts` uses `findFirstUserMessage(messages)` and `findLastUserMessage(messages)`. When messages include compaction system messages (which may have role "user" as a system-injected prompt), the thread summary starts with the compaction summary text instead of actual user conversation.

### Root Cause
System-injected messages (compaction summaries, checkpoint injections, gauge lines) can have role "user" but aren't real user messages. No filtering applied.

### Fix

**A. Filter system messages before thread/exchange extraction:**

**BLOCKER fix** (Codex R1 #1): The original spec had two errors:
1. Checkpoint injection uses `<checkpoint-data` tag (NOT `<checkpoint>`) — verified in `context-checkpoint-inject.ts:35`
2. System events via `enqueueSystemEvent` are plain text injected into the message queue with role "user" — they have NO `customType` field. The `customType === "system-event"` check would never match anything.

```typescript
function isRealUserMessage(msg: AgentMessage): boolean {
  const role = (msg as { role?: string })?.role;
  if (role !== "user") return false;
  const text = extractText(msg);
  // Skip checkpoint injection messages (actual tag used in context-checkpoint-inject.ts)
  if (text.includes("<checkpoint-data")) return false;
  // Skip messages containing checkpoint schema markers
  if (text.includes("schema: openclaw/checkpoint")) return false;
  // Skip compaction summaries (injected as plain text with role "user")
  if (text.startsWith("Summary unavailable") || text.startsWith("This summary covers")) return false;
  // Skip token gauge lines (injected via enqueueSystemEvent as plain text)
  if (text.startsWith("Token utilization:") || text.startsWith("## Token Gauge")) return false;
  return true;
}
```

**Note:** Since system events lack `customType`, detection must be content-based. The patterns above cover all known injection paths: checkpoint data, compaction summaries, and token gauge lines. If new injection patterns are added in the future, this function must be updated.

**B. Use `isRealUserMessage` in:**
- `findFirstUserMessage` — filter to real user messages
- `findLastUserMessage` — filter to real user messages
- `buildKeyExchanges` — skip non-real user messages when building pairs

### Files
- `src/agents/pi-extensions/context-manager.ts` — add `isRealUserMessage`, update `findFirstUserMessage`, `findLastUserMessage`, `buildKeyExchanges`

---

## Issue 4: `last_tool_call: null` Despite Recent Tool Use

### Problem
`last_tool_call` was `null` in checkpoint despite browser tool being used immediately before compaction.

### Root Cause
The runtime `lastToolCall` is in-memory only. Multiple scenarios can produce `null`:
1. **Runtime identity**: `getContextManagerRuntime` might return different instances in different calling contexts (compaction handler vs tool_result handler)
2. **Timing**: Compaction fires during `context` event; tool_result event may not have been processed yet
3. **Process restart**: Runtime is ephemeral — any restart loses the value

### Fix

**BLOCKER** (Codex R1 #2): State-file persistence is MANDATORY, not a fallback. In-memory runtime is inherently unreliable for cross-handler data sharing. Fix both paths:

**A. Persist `lastToolCall` to state files** (primary — always reliable):

New function in `context-state.ts`:
```typescript
export async function writeLastToolCallToState(
  stateDir: string,
  sessionKey: string,
  toolCall: { name: string; paramsSummary: string },
): Promise<void> {
  const dir = path.join(stateDir, "context", "state", sessionKey);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "last_tool_call.json"),
    JSON.stringify(toolCall),
  );
}

export async function readLastToolCallFromState(
  stateDir: string,
  sessionKey: string,
): Promise<{ name: string; paramsSummary: string } | null> {
  try {
    const data = await fs.readFile(
      path.join(stateDir, "context", "state", sessionKey, "last_tool_call.json"),
      "utf-8",
    );
    return JSON.parse(data);
  } catch {
    return null;
  }
}
```

**B. Update `tool_result` handler** in `context-manager.ts`: call `writeLastToolCallToState` alongside existing `runtime.lastToolCall` assignment.

**C. Update `buildCheckpointFromState`** in `compaction-safeguard.ts`: read from state files via `readLastToolCallFromState` instead of from runtime. Runtime value becomes a redundant optimization, not the source of truth.

**D. Keep runtime field** for in-session fast access (no disk read needed for non-checkpoint uses), but checkpoint builder always reads from state files.

### Files
- `src/agents/context-state.ts` — add `writeLastToolCallToState`, `readLastToolCallFromState`
- `src/agents/pi-extensions/context-manager.ts` — call `writeLastToolCallToState` in tool_result handler
- `src/agents/pi-extensions/compaction-safeguard.ts` — read from state files in checkpoint builder

---

## Improvement 5: Enrichment Prompt Tuning

### Problem
The enrichment prompt in `context-enrichment.ts` asks the LLM to "refine existing decisions: deduplicate, clarify wording, add any missed from recent context, remove resolved ones." But it also says "Do NOT discard decisions you cannot verify." These are somewhat contradictory — the LLM keeps garbage decisions it can't verify as resolved, and the merge safety net preserves them too.

### Fix

**A. Strengthen the prompt instruction:**
```
Refine these existing decisions:
- REMOVE entries that are not actual decisions (conversational text, questions, narrative)
- Deduplicate semantically similar entries (keep the cleaner version)
- Clarify wording to be concise, action-oriented statements
- Add any decisions from recent context that are missing
- Keep decisions you cannot verify as resolved — but DO remove entries that are clearly not decisions (e.g., starts with "You're right" or "Ohoho")

An entry is a DECISION if it records: a choice made, an approach selected, a trade-off accepted, or a direction confirmed. Conversational acknowledgments, questions, and narrative descriptions are NOT decisions.
```

**B. Add explicit examples of good vs bad decisions in the prompt:**
```
GOOD decisions: "Use atomicWriteFile for checkpoint re-write to bypass dedup", "Merge strategy: LLM decisions + preserved heuristics via set-diff"
BAD (not decisions): "You're right, I overcomplicated it", "- I need to send him a plan", "Ohoho. Claude Code Remote Control"
```

**C. Token budget** (Codex R1 #7): Adding good/bad examples increases prompt tokens. Current `maxTokens: 500` for enrichment response stays fixed. But trim the recent-message slice from 20 messages to 15 if the prompt with examples exceeds ~1500 tokens. The examples add ~100 tokens — minimal impact, but document the budget awareness.

### Files
- `src/agents/context-enrichment.ts` — update `buildEnrichmentPrompt`, add examples, adjust message slice if needed

---

## Improvement 6: Open Items Dedup at Capture Time

### Problem
Open items can accumulate duplicates before enrichment even runs. The `appendOpenItemToState` in `context-state.ts` uses `items.includes(item)` — exact string match. "Send Grigorije a plan" and "- I need to send him a plan" both pass.

### Fix

Use the same `isSemanticDuplicate` function at capture time:

```typescript
// In appendOpenItemToState:
if (items.some(existing => isSemanticDuplicate(existing, item))) {
  return; // Skip semantic duplicate
}
```

Same for `appendDecisionToState` — currently uses `normalizeLearningFingerprint` which only strips leading punctuation and collapses whitespace. Replace with `isSemanticDuplicate` check.

### Files
- `src/agents/context-state.ts` — update `appendOpenItemToState` and `appendDecisionToState`
- Import `isSemanticDuplicate` from `context-dedup.ts`

---

## Implementation Summary

### New Files
| File | Purpose |
|------|---------|
| `src/agents/context-dedup.ts` (~80 lines) | **Pure utility** — `isSemanticDuplicate()`, `normalize()`, `extractKeywords()`, `STOP_WORDS`. Zero imports from context-state/compaction/enrichment/pi-extensions. |
| `tests/agents/context-dedup.test.ts` | Unit tests for `isSemanticDuplicate`, `extractKeywords`, normalization, cardinality guard |
| `tests/agents/context-manager-filters.test.ts` | Unit tests for `extractDecisionFromResponse`, `isRealUserMessage` |

### Modified Files
| File | Changes |
|------|---------|
| `src/agents/pi-extensions/context-manager.ts` | `extractDecisionFromResponse` (4-tier pattern matching), action-verb quality gate, `isRealUserMessage` (content-based detection), thread/exchange filtering |
| `src/agents/pi-extensions/compaction-safeguard.ts` | Replace literal dedup with `isSemanticDuplicate` in merge blocks, read `lastToolCall` from state files |
| `src/agents/context-enrichment.ts` | Updated enrichment prompt with decision definition + good/bad examples, message slice budget awareness |
| `src/agents/context-state.ts` | Semantic dedup in `appendOpenItemToState` and `appendDecisionToState`, new `writeLastToolCallToState` / `readLastToolCallFromState` |

### Schema
No schema version bump needed. All changes are to capture quality, merge logic, and state persistence — not checkpoint structure.

### Verification
1. `pnpm build` — clean compile
2. `pnpm test` — no regressions, new tests pass
3. Manual: trigger compaction → verify:
   - Decisions are clean action-oriented statements (no conversational noise)
   - No duplicate open items (semantic overlap eliminated)
   - Thread summary starts with actual user message, not system content
   - `last_tool_call` populated after tool use (read from state file)
4. Manual: run enrichment → verify merged decisions don't have garbage entries from heuristics

### Required Unit Tests (Codex R1 #10)

**`context-dedup.test.ts`:**
- `isSemanticDuplicate` — normalized exact match (formatting diffs)
- `isSemanticDuplicate` — keyword overlap above/below 0.5 threshold
- `isSemanticDuplicate` — substring containment (>= 10 chars)
- `isSemanticDuplicate` — cardinality guard (< 3 keywords → skip Jaccard, fall through)
- `isSemanticDuplicate` — Serbian stop words filtered correctly
- `isSemanticDuplicate` — false negative: genuinely different items with shared vocabulary survive

**`context-manager-filters.test.ts`:**
- `extractDecisionFromResponse` — extracts tier 1 (explicit marker) over tier 3 (bold)
- `extractDecisionFromResponse` — returns null for conversational filler
- `extractDecisionFromResponse` — returns null for code-fence-only response
- `extractDecisionFromResponse` — action verb bullet extraction (tier 4)
- `isRealUserMessage` — passes real user messages
- `isRealUserMessage` — rejects `<checkpoint-data` content
- `isRealUserMessage` — rejects compaction summaries
- `isRealUserMessage` — rejects token gauge lines
- Merge preservation: heuristic decisions not covered by LLM output are preserved after semantic dedup

### Risk Assessment
- **isSemanticDuplicate false positives**: Jaccard 0.5 threshold could merge genuinely different items that share vocabulary. Mitigated by: 3-tier approach (must match one of: normalized exact, keyword overlap, substring containment), cardinality guard (< 3 keywords → skip Jaccard), short-circuit on cheap normalized equality.
- **extractDecisionFromResponse false negatives**: Strict 4-tier patterns may miss informal decisions. Acceptable — missing a decision is better than capturing noise. LLM enrichment catches missed decisions.
- **Stop word list completeness**: Too few stops = low Jaccard for real duplicates. Too many = high Jaccard for distinct items. Starting conservative with English + Serbian, tune based on production data.
- **Content-based system message detection**: `isRealUserMessage` uses text pattern matching since system events lack `customType`. If new injection patterns are added, the function needs updating. Mitigated by: covering all current injection paths (checkpoint, compaction, gauge).

### Codex R1 Findings Tracker
| # | Type | Finding | Resolution |
|---|------|---------|------------|
| 1 | BLOCKER | `isRealUserMessage` uses wrong tag (`<checkpoint>`) and nonexistent `customType` | Fixed: `<checkpoint-data` tag, content-based detection, no `customType` |
| 2 | BLOCKER | `lastToolCall` debug-first approach; in-memory is unreliable | Fixed: state-file persistence mandatory, runtime kept as optimization |
| 3 | GAP | `/[A-Z_]/` quality gate too brittle | Fixed: action-verb lexicon + structural marker detection |
| 4 | GAP | Decision patterns underspecified | Fixed: 4-tier matching with concrete regexes and priority |
| 5 | GAP | Jaccard on tiny keyword sets produces false positives | Fixed: cardinality guard (< 3 keywords → skip) |
| 6 | RISK | Stop words English-only | Fixed: added Serbian (Latin script) stop words |
| 7 | RISK | Adding examples increases prompt tokens vs fixed maxTokens | Fixed: message slice budget awareness, trim if needed |
| 8 | NIT | Semantic dedup hot path without short-circuit | Fixed: cheap normalized equality precheck, cache note |
| 9 | GAP | `context-dedup.ts` dependency direction | Fixed: declared as pure utility, zero back-imports |
| 10 | GAP | No unit tests specified | Fixed: full test requirements for dedup, extraction, filtering |
