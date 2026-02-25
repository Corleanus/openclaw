# OpenClaw Context Manager v1 — Design Specification

**Version:** 1.1
**Date:** 2026-02-25
**Status:** Design — Pre-Implementation
**Based on:** Claudex v3 Architecture Specification, adapted for OpenClaw agent runtime
**Reviewed by:** Codex gpt-5.3 (14 findings, all addressed in this revision)

---

## 1. Problem Statement

OpenClaw's Pi agent runtime faces the same context degradation problem as every LLM-based agent:

1. **Compaction is lossy.** The current 3-layer compaction system (safeguard + overflow + context pruning) produces LLM-generated summaries that consume 30-50k tokens on reload. Decisions, rationale, and conditional logic are silently dropped.
2. **No structured state capture.** When compaction fires, the agent loses structured understanding of what it was doing. The LLM summary provides conversational glue but not factual accuracy.
3. **No context utilization awareness.** The agent doesn't know how full its context window is. There's no proactive action at 80% — compaction only fires when the window is already overflowing.
4. **Session amnesia.** Each new session starts from scratch. The mem0 plugin provides user-level long-term memory (facts, preferences), but there's no mechanism for work-level continuity (what was in progress, where we stopped).
5. **No selection pressure on memory.** The core memory system has basic temporal decay on file modification time, but no access tracking, importance stratification, or proven decay formulas.

## 2. Design Principles

**P1: Write Before Forgetting.** Structured state goes to disk before compaction can compress it away. The checkpoint is written at 80% utilization — before compaction fires at ~95%.

**P2: Complement, Don't Replace.** The existing compaction system becomes the safety net. mem0 continues handling long-term user memory. The context manager handles work-level continuity. All three coexist.

**P3: No LLM Calls in the Hot Path.** Checkpoint writing, token gauge calculation, and incremental state capture are pure computation. LLM calls happen only in the existing compaction summarizer (which becomes conversational glue, not the primary state capture).

**P4: Core Integration.** The context manager lives in core (`src/agents/`), not as a plugin. The richest integration point (`session_before_compact` extension event) is only available at the core level. Plugin hooks (`before_compaction`) are fire-and-forget and lack the data needed.

**P5: Lean Reload.** Post-compaction context reload targets ~600-800 tokens of structured checkpoint data, vs ~30-50k tokens for the current LLM summary approach.

**P6: Follow Existing Patterns.** Integration follows proven patterns already in the codebase: post-compaction injection via `enqueueSystemEvent()`, extension registration via `buildEmbeddedExtensionFactories()`, session-scoped runtime values via the compaction-safeguard-runtime pattern.

## 3. Relationship to Existing Systems

```
+---------------------------------------------------------------------+
|                     WHAT EACH SYSTEM DOES                           |
|                                                                     |
|  Context Manager (NEW)         mem0 Plugin (EXISTS)                 |
|  ---------------------         --------------------                 |
|  Work-level continuity         User-level long-term memory          |
|  Structured checkpoints        Extracted facts (LLM-driven)         |
|  Token gauge + 80% threshold   Semantic similarity search           |
|  Incremental state capture     Auto-capture from conversations      |
|  Session boundary handoff      Cross-session identity/preferences   |
|  Mechanical (no LLM)           LLM fact extraction (gpt-4o-mini)   |
|                                                                     |
|  Core Memory (EXISTS)          Compaction (EXISTS -> SAFETY NET)    |
|  --------------------          -------------------------------      |
|  SQLite + sqlite-vec + FTS5    LLM summarization                    |
|  Hybrid search (vector+BM25)   Context pruning (soft/hard trim)     |
|  memory_search/memory_get      Overflow detection + retry           |
|  Workspace markdown files      compaction-safeguard extension       |
|                                                                     |
|  Memory Flush (EXISTS)         Post-Compaction Context (EXISTS)     |
|  ---------------------         --------------------------------     |
|  Pre-compaction LLM turn       AGENTS.md section injection          |
|  Writes to memory/*.md         enqueueSystemEvent() pattern         |
|  Threshold-based trigger       Drives agent re-read of startup      |
+---------------------------------------------------------------------+
```

**Data flow between systems:**
- Context Manager captures `learnings` at checkpoint time -> written to checkpoint file for agent to manually promote via `memory_store` tool (no automatic mem0 API call)
- mem0's `before_agent_start` injection continues independently -- user-level facts
- Context Manager injects post-compaction via `enqueueSystemEvent()` -- same pattern as existing post-compaction context (`agent-runner.ts:678`)
- Memory flush runs before compaction (existing) -- checkpoint write runs inside compaction-safeguard AFTER memory flush, BEFORE LLM summarization
- Core Memory continues as agent tool (`memory_search`) -- unchanged

## 4. Architecture Overview

```
+------------------------------------------------------------------+
|                    AGENT CONTEXT WINDOW (RAM)                     |
|                                                                   |
|  +- SYSTEM PROMPT (~5-10k tokens) ----------------------------+  |
|  |  Tool definitions, safety rules, workspace files            |  |
|  |  Bootstrap files (AGENTS.md, SOUL.md, etc.)                 |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +- INJECTED BLOCK (~2-4k tokens, per prompt) ----------------+  |
|  |  Token gauge: [Context: 81% | 162k/200k]                   |  |
|  |  Post-compact checkpoint data (via system event)            |  |
|  |  mem0 recalled memories (user-level facts, via prependCtx)  |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  +- CONVERSATION (grows naturally) ---------------------------+  |
|  |  User messages + Agent responses + Tool calls               |  |
|  +-------------------------------------------------------------+  |
|                                                                   |
|  === 80% === CHECKPOINT FIRES ====================================|
|  === ~95% == COMPACTION FIRES (safety net) ========================|
+------------------------------------------------------------------+
                    | writes down              | reads up
                    v                          ^
+------------------------------------------------------------------+
|                         DISK (Storage)                            |
|                                                                   |
|  <stateDir>/context/checkpoints/  <- Structured YAML snapshots   |
|  <stateDir>/context/state/        <- Running incremental capture  |
|  <stateDir>/sessions/             <- Session JSONL transcripts    |
|  <workspace>/memory/              <- Curated memory (markdown)    |
|  mem0 store (memories.json / API) <- Long-term user facts         |
+------------------------------------------------------------------+
```

## 5. Checkpoint Schema Specification

### 5.1 Format

YAML. Machine-first, human-readable. Parsed programmatically via the existing `yaml` package (already a dependency at `^2.8.2` -- do NOT add `js-yaml`).

> **Codex finding #14 resolved:** Repo already depends on the `yaml` npm package. No new YAML dependency needed.

**YAML safety rules:**
- Free-text fields use block scalars (`|` or `>`) to avoid colon/quote issues
- Tool names are always quoted strings
- No user-controlled content in YAML keys (injection prevention)

### 5.2 Storage Location

```
<stateDir>/context/checkpoints/
+-- <safe_session_dir>/
|   +-- _latest.json               <- Per-session pointer: { checkpoint_id, path }
|   +-- cp_001.yaml
|   +-- cp_002.yaml
|   +-- ...
```

> **Codex finding #4 resolved:** Session keys contain `:` and other characters invalid on Windows. Directory names are derived via `sanitizeSessionKeyForPath()`:
> ```typescript
> function sanitizeSessionKeyForPath(sessionKey: string): string {
>   return sessionKey.replace(/[^a-zA-Z0-9._-]/g, '_');
> }
> ```
> This mirrors the existing `SAFE_SESSION_ID_RE` pattern from `src/config/sessions/paths.ts`.

> **Codex finding #5 resolved:** `_latest.json` is per-session-key, not global. Each session directory has its own pointer. No cross-session races. Multi-agent/multi-session writes are isolated by directory.

Checkpoint files are **immutable once written** -- new checkpoint = new file. Deletion of old checkpoints is a separate cleanup step (never modifies existing files).

> **Codex finding #12 resolved:** No "append-only" claim. Checkpoints are write-once immutable files. Retention policy deletes OLD files (not modifying existing ones). Atomic writes use tmp + rename with Windows EPERM fallback (same pattern as mem0's `save()` and `writeConfigFile()` in `src/config/io.ts`). Repeated >80% writes in the same session are deduplicated by comparing `token_usage.input_tokens` against the last checkpoint -- if delta < 5%, skip the write.

### 5.3 Full Schema

```yaml
# OpenClaw Checkpoint Schema v1
schema: "openclaw/checkpoint"
schema_version: 1

# --- METADATA ------------------------------------------------
meta:
  checkpoint_id: "cp_003"
  session_key: "telegram:user123"
  session_file: "sessions/telegram-user123.jsonl"
  created_at: "2026-02-24T15:30:00Z"
  trigger: "auto-80pct"              # auto-80pct | compaction | session-end
  compaction_count: 2                # how many compactions this session
  token_usage:
    input_tokens: 162431             # from ctx.getContextUsage() or estimateContextTokens()
    context_window: 200000           # from ctx.getContextUsage().contextWindow
    utilization: 0.81                # percent from SDK, or computed
  previous_checkpoint: "cp_002"      # linked list for history walking
  channel: "telegram"
  agent_id: "default"

# --- WORKING STATE -------------------------------------------
working:
  topic: |
    Helping user plan a trip to Japan
  status: "in_progress"              # in_progress | idle | waiting_for_user
  interrupted: false                 # true if CompactionPreparation.isSplitTurn
  last_tool_call: null               # { name, params_summary } if interrupted
  next_action: |
    User asked about visa requirements -- need to answer

# --- DECISIONS -----------------------------------------------
decisions:
  - id: "d1"
    what: |
      User prefers budget options over luxury
    when: "2026-02-24T14:15:00Z"
  - id: "d2"
    what: |
      Flights from Belgrade, March 15-29 window
    when: "2026-02-24T14:22:00Z"

# --- RESOURCES -----------------------------------------------
resources:
  files_read: []                     # workspace files read during session
  files_modified: []                 # workspace files modified during session
  tools_used:                        # deduplicated tool names invoked during session
    - "web_search"
    - "memory_search"

# --- THREAD --------------------------------------------------
thread:
  summary: |
    Planning Japan trip. Settled on March dates, budget focus.
  key_exchanges:
    - role: "user"
      gist: |
        I want to go to Japan in March, budget-friendly
    - role: "agent"
      gist: |
        Proposed 2-week itinerary Tokyo-Kyoto-Osaka, ~$2k budget
    - role: "user"
      gist: |
        Looks good, what about visa?

# --- OPEN ITEMS ----------------------------------------------
open_items:
  - "Visa requirements for Serbian passport"
  - "User hasn't decided on accommodation style"

# --- LEARNINGS -----------------------------------------------
# Written to checkpoint for agent visibility. Agent can manually
# promote to long-term memory via memory_store tool.
# NOT automatically routed to mem0 (no runtime API exists).
learnings:
  - "User is price-sensitive, always ask about budget first"
```

> **Codex finding #9 resolved:** Learnings are NOT automatically routed to mem0. The `provider.add()` API is internal to mem0, not exposed via the plugin runtime. Instead, learnings are written to the checkpoint file. The agent can choose to promote them via the `memory_store` tool (which mem0 exposes). Automatic promotion is deferred to a future version that defines a cross-plugin memory write API.

### 5.4 Selective Loading Rules

| Section | When Loaded | Typical Tokens |
|---------|-------------|----------------|
| meta (gauge + IDs only) | Post-compact resume | ~30 |
| working | Post-compact resume | ~60 |
| open_items | Post-compact resume | ~50 |
| decisions | Post-compact resume | ~200 |
| thread | Post-compact resume | ~150 |
| resources | Post-compact resume | ~50 |
| learnings | Post-compact resume (agent can promote) | ~60 |
| **Total typical load** | | **~600-700** |

### 5.5 Checkpoint Retention

- Keep last 5 checkpoints per session key (rolling window)
- Older checkpoint FILES are deleted during cleanup (immutable files, never modified)
- `compaction_count > 3` triggers a warning in the post-compact injection

### 5.6 Design Decision: Disk Files vs SessionManager Custom Entries

> **Codex finding #11 addressed.**

The pi-coding-agent SDK provides `appendCustomEntry(customType, data)` and `appendCustomMessageEntry()` for storing extension data in the session JSONL. These are tied to the session tree (branches, forks, resets).

**Why we use disk files instead:**
- **Checkpoints must survive compaction.** Compaction drops old JSONL entries -- that's the entire point. Custom entries in the pre-compaction portion would be discarded along with the messages they're meant to preserve.
- **Checkpoints must survive process termination.** JSONL entries are in-memory until flushed. Disk files are durable immediately after atomic write.
- **Cross-session resume.** A new session for the same session key starts with an empty JSONL. Checkpoint files persist across sessions.

**Reconciliation with session tree:** Checkpoint files are keyed by session key (same as session JSONL). Session resets (via `/new` command) create a new session ID but may keep the same session key. The checkpoint from the prior session remains valid for resume. If the user explicitly creates a NEW session key, there are no checkpoints to load -- clean start, as expected.

## 6. Token Gauge

### 6.1 Data Source

> **Codex finding #7 resolved:** The spec now uses the SDK's `ctx.getContextUsage()` API as the primary source, which accounts for system prompt, bootstrap files, tool definitions, and all other overhead. Fallback to heuristic estimation only when the SDK returns `null`.

**Primary:** `ctx.getContextUsage()` from `ExtensionContext` (available in extension events). Returns `{ tokens: number | null, contextWindow: number, percent: number | null }`. This is the authoritative source -- it uses `getLastAssistantUsage()` from the SDK's compaction module, which reads actual API response metadata.

**Fallback:** `estimateContextTokens(messages)` from `pi-coding-agent` compaction module. Uses the last assistant message's `usage.input_tokens` when available, falls back to chars/4 heuristic for trailing messages. Returns `ContextUsageEstimate { tokens, usageTokens, trailingTokens, lastUsageIndex }`.

**Context window:** From `ctx.getContextUsage().contextWindow`, which already incorporates model metadata, config overrides, and the agent context token cap.

### 6.2 Calculation

Inside the context-manager extension's `context` event handler (fires every LLM call):

```typescript
const usage = ctx.getContextUsage();
if (usage?.percent != null) {
  utilization = usage.percent / 100;  // SDK returns percentage, we use 0-1 ratio
} else {
  // Fallback: estimate from messages
  const estimate = estimateContextTokens(messages);
  utilization = estimate.tokens / contextWindowTokens;
}
```

### 6.3 Threshold Actions

| Utilization | Action |
|-------------|--------|
| < 70% | No injection (save tokens) |
| 70-80% | Gauge injected into agent's context via extension |
| >= 80% | **Write checkpoint** + gauge + advisory note |
| ~95% | Existing compaction fires (safety net -- checkpoint already on disk) |

**80% threshold alignment with compaction:**

> **Codex finding #7 continued:** The 80% threshold is intentionally BELOW the compaction trigger. The SDK's `shouldCompact()` uses `contextTokens > contextWindow - reserveTokens` (where `reserveTokens` defaults to 20k). For a 200k window, compaction fires at ~180k tokens (90%). Our 80% checkpoint fires at ~160k tokens -- well before compaction, giving ~20k tokens of working space after the checkpoint.

### 6.4 Injection Format

Injected into the agent's context via the extension's `context` event handler (not `prependContext` -- this avoids token budget conflicts with mem0):

```
[Context: 81% | 162k/200k tokens | Checkpoint saved]
```

One line. ~15 tokens. Informational for the agent.

## 7. Incremental State Capture

### 7.1 State Files

```
<stateDir>/context/state/<safe_session_dir>/
+-- decisions.json         <- Logged as they happen
+-- thread.json            <- Running conversation state
+-- resources.json         <- Files and tools used
+-- open_items.json        <- Tracked open items
```

JSON format (not YAML) for incremental writes. Session directory name uses the same `sanitizeSessionKeyForPath()` as checkpoints.

### 7.2 Capture Mechanisms

> **Codex finding #8 resolved:** The plugin `after_tool_call` hook sends `agentId: undefined, sessionKey: undefined` -- confirmed in source (`pi-embedded-subscribe.handlers.tools.ts:429-430`). We do NOT use plugin hooks for incremental capture. Instead, all incremental capture happens inside the **context-manager extension**, which has full `ExtensionContext` including `ctx.sessionManager` and the session key (stored in a runtime value, same pattern as `compaction-safeguard-runtime.ts`).

**Layer A: Mechanical Capture (extension `tool_result` event)**

The context-manager extension registers on `tool_result` events (not the plugin `after_tool_call` hook). The extension has full context including session identity. Captures:
- Tool name -> `resources.json` (tools_used, deduplicated)
- File read/write paths (extracted from tool params: `path` field for read/write/edit tools) -> `resources.json`
- Tool failures (isError flag) -> `thread.json` (errors section)

Pure data extraction. No LLM.

**Layer B: Structural Pattern Recognition (extension `context` event)**

Fires every LLM call. Pure computation on the message array:
- Extract last user message gist -> `thread.json` (current topic)
- Detect decision-like patterns: short user message (<50 chars) after long agent response -> `decisions.json`

**Layer C: At Checkpoint Time**

When checkpoint fires (80% threshold or compaction), the extension reads all state files and bundles them into the checkpoint YAML. State files are reset (truncated to empty arrays) for the next accumulation cycle.

### 7.3 State File Lifecycle

```
Extension loaded -> state dir created (empty JSON arrays)
During session -> extension events append incrementally
80% threshold -> bundle into checkpoint, reset files
Compaction -> checkpoint updated if state changed since 80%, reset files
Process exit -> best effort (state files remain on disk for next session)
```

> **Codex finding #1 resolved:** `session_end` is NOT used for final checkpoint writes. OpenClaw only fires `session_end` during session reset/new-session flows -- NOT on process termination. The primary checkpoint mechanisms are (1) the 80% threshold (in the extension's `context` event) and (2) the `session_before_compact` extension event (inside compaction-safeguard). Process termination without compaction means state files remain on disk; the next session's first checkpoint will bundle them. This is acceptable -- the state files ARE the incremental capture, and the checkpoint is the bundle.

## 8. Integration Points

### 8.1 compaction-safeguard.ts Enhancement

**Current behavior:** Captures file ops + tool failures, runs LLM summarization, returns `CompactionResult` with summary.

**New behavior (additive -- existing flow unchanged):**
1. Read incremental state files from `<stateDir>/context/state/<safe_session_dir>/`
2. Read `CompactionPreparation.fileOps` for authoritative file lists (supplements incremental capture)
3. Read `CompactionPreparation.isSplitTurn` for interrupted state
4. Bundle into checkpoint YAML, write to `<stateDir>/context/checkpoints/<safe_session_dir>/cp_N.yaml`
5. Update `_latest.json` pointer in the session directory
6. Reset state files (empty arrays)
7. **Existing flow continues:** Run LLM summarization, return summary as before

> **Codex finding #3 resolved:** Checkpoint write happens EXCLUSIVELY inside `compaction-safeguard.ts` via the `session_before_compact` extension event, which is **awaited** by the SDK (not fire-and-forget). The plugin `before_compaction` hook is NOT used for checkpoint writes. The 80% threshold checkpoint is written from the extension's `context` event handler, which also runs synchronously within the extension lifecycle.

The checkpoint write is a simple file write (~2-3kb YAML). It completes in <5ms. It happens BEFORE the LLM summarization call (which takes seconds). If summarization fails, structured state is already on disk.

**Coordination with memory flush:**

> **Codex finding #10 resolved:** OpenClaw already runs a pre-compaction memory flush (`memory-flush.ts`) that triggers a separate agent turn to write memories to disk. This runs BEFORE compaction-safeguard. The checkpoint write runs INSIDE compaction-safeguard, which runs AFTER memory flush. Sequence:
>
> 1. Memory flush detects threshold -> runs LLM turn -> writes to `memory/*.md`
> 2. Compaction triggers -> `session_before_compact` fires
> 3. compaction-safeguard: **checkpoint write** (new)
> 4. compaction-safeguard: LLM summarization (existing)
> 5. Post-compaction: system event injection (existing + new checkpoint data)
>
> No ordering conflict. Checkpoint captures the state AFTER memory flush has already run.

### 8.2 Post-Compaction Checkpoint Injection

**Existing pattern (agent-runner.ts:678-693):** After compaction, OpenClaw calls `readPostCompactionContext(workspaceDir)` and injects the result via `enqueueSystemEvent(content, { sessionKey })`. This injects AGENTS.md "Session Startup" and "Red Lines" sections.

**New behavior:** Add checkpoint data injection alongside the existing AGENTS.md injection. Same mechanism, same function call site.

> **Codex finding #2 resolved:** The spec no longer claims to inject via `session_start` (which can't return context mutations) or `before_prompt_build` (token budget conflict with mem0). Instead, post-compaction injection uses the established `enqueueSystemEvent()` pattern, which injects a system event message into the session's message queue. The agent receives it as a system message on the next turn -- proven pattern, already working for AGENTS.md injection.

```typescript
// In agent-runner.ts, after existing readPostCompactionContext():
const checkpointContent = await readCheckpointForInjection(sessionKey);
if (checkpointContent) {
  enqueueSystemEvent(checkpointContent, { sessionKey });
}
```

The injected content is formatted as a structured text block:

```
[Post-compaction checkpoint restore]

Working on: Helping user plan a trip to Japan
Status: in_progress
Next action: User asked about visa requirements -- need to answer

Decisions made:
- User prefers budget options over luxury (14:15)
- Flights from Belgrade, March 15-29 window (14:22)

Thread: Planning Japan trip. Settled on March dates, budget focus.

Open items:
- Visa requirements for Serbian passport
- User hasn't decided on accommodation style

Learnings (consider storing to long-term memory):
- User is price-sensitive, always ask about budget first
```

This is rendered from the YAML checkpoint into agent-readable text. ~600-700 tokens.

### 8.3 Extension Registration

**New file: `src/agents/pi-extensions/context-manager.ts`**

Registered in `buildEmbeddedExtensionFactories()` in `src/agents/pi-embedded-runner/extensions.ts` (alongside compaction-safeguard and context-pruning).

> **Codex finding #6 resolved:** Extension registration is in `extensions.ts`, not `run.ts`. `resolveContextWindowTokens()` is a local function in `extensions.ts` (wraps `resolveContextWindowInfo()` from `context-window-guard.ts`). All file references in this spec are verified against the actual codebase.

**Runtime value pattern:** Following the `compaction-safeguard-runtime.ts` pattern, create `context-manager-runtime.ts` to store session-scoped values (session key, context window tokens) accessible from the extension.

```typescript
// src/agents/pi-extensions/context-manager-runtime.ts
export function setContextManagerRuntime(
  sessionManager: SessionManager,
  values: { sessionKey: string; contextWindowTokens: number; stateDir: string }
): void;

export function getContextManagerRuntime(
  sessionManager: SessionManager
): ContextManagerRuntimeValue | undefined;
```

**Extension events registered:**

| Event | Action |
|-------|--------|
| `context` | Token gauge calculation via `ctx.getContextUsage()`; inject gauge if >70%; write checkpoint if >80% |
| `tool_result` | Incremental capture: tool name, file paths, failures -> state files |

The `session_before_compact` checkpoint write is called from compaction-safeguard (not a separate extension registration -- it's an additive call within the existing handler).

### 8.4 Interaction with mem0

- mem0 injects via `prependContext` in `before_agent_start` hook -- user-level facts
- Context manager injects post-compaction via `enqueueSystemEvent()` -- work-level state
- **Different injection mechanisms, no conflict.** mem0 prepends to user message; checkpoint is a separate system event message
- Token budget: checkpoint injection is ~600-700 tokens as a system event; mem0's injection has its own `topK` limit. They don't compete for the same budget.
- Learnings: written to checkpoint file. Agent can promote manually via mem0's `memory_store` tool. No automatic cross-plugin API call.

### 8.5 Interaction with Existing Post-Compaction Systems

> **Codex finding #10 resolved in detail.**

| System | Hook Point | What It Does | Coordination |
|--------|-----------|-------------|--------------|
| Memory flush | Pre-compaction (agent-runner-memory.ts) | Runs LLM turn to write memories to disk | Runs BEFORE compaction; checkpoint captures state AFTER |
| AGENTS.md injection | Post-compaction (agent-runner.ts:678) | `enqueueSystemEvent()` with startup rules | Checkpoint injection added ALONGSIDE, same call site |
| Post-compaction audit | Post-compaction (agent-runner.ts:707) | Checks agent read required files | Unchanged; checkpoint injection is a separate system event |
| Compaction-safeguard | During compaction (extension event) | LLM summarization + file ops | Checkpoint write added BEFORE summarization, same handler |

No duplicated or competing context blocks. Each system injects its own distinct content via its own mechanism.

## 9. Module Inventory

### 9.1 New Files

| File | Purpose | Effort |
|------|---------|--------|
| `src/agents/context-checkpoint.ts` | Checkpoint YAML writer/reader, schema types, path sanitization, atomic write, retention pruning | Medium |
| `src/agents/context-gauge.ts` | Token utilization calculation using SDK `ContextUsage` API, gauge formatting | Small |
| `src/agents/context-state.ts` | Incremental state accumulator (JSON read/write for decisions, thread, resources, open_items) | Medium |
| `src/agents/pi-extensions/context-manager.ts` | Extension: `context` + `tool_result` event handlers | Medium |
| `src/agents/pi-extensions/context-manager-runtime.ts` | Session-scoped runtime values (session key, state dir) | Small |
| `src/agents/context-checkpoint-inject.ts` | Render checkpoint YAML into agent-readable text for system event injection | Small |

### 9.2 Modified Files

| File | Change | Risk |
|------|--------|------|
| `src/agents/pi-extensions/compaction-safeguard.ts` | Add checkpoint write call before LLM summarization (~15 lines) | Medium -- modifying core compaction path |
| `src/agents/pi-embedded-runner/extensions.ts` | Register context-manager extension in `buildEmbeddedExtensionFactories()` (~10 lines) | Low -- additive, follows existing pattern |
| `src/auto-reply/reply/agent-runner.ts` | Add checkpoint injection call alongside existing `readPostCompactionContext()` (~5 lines) | Low -- additive, same pattern |

### 9.3 New Dependencies

None. Uses existing `yaml` package (`^2.8.2`).

> **Codex finding #14 resolved.**

### 9.4 No Changes Required

- mem0 plugin -- continues unchanged
- Core memory system -- continues unchanged
- `compaction.ts` -- existing summarization functions untouched
- `context-pruning/` -- existing context pruning untouched
- `memory-flush.ts` -- existing pre-compaction memory flush untouched
- `post-compaction-context.ts` -- existing AGENTS.md injection untouched
- Plugin hook system -- used as-is (but NOT for checkpoint writes or incremental capture)

## 10. Data Flow

### 10.1 Normal Session (No Compaction)

```
Session starts
  +-- extensions.ts registers context-manager extension
  +-- context-manager-runtime.ts stores session key + state dir
  +-- context-manager checks for checkpoint -> none found -> no injection

User sends message
  +-- context event: ctx.getContextUsage() -> 24% -> no injection
  +-- mem0 before_agent_start: recalls user memories -> prependContext

Agent responds, uses tools
  +-- tool_result event: captures tool name + file paths -> state files

... conversation continues ...

User sends message
  +-- context event: ctx.getContextUsage() -> 74% -> inject gauge line

Agent responds

Process exits
  +-- state files remain on disk (best effort)
  +-- next session: first checkpoint will bundle them
```

### 10.2 Long Session (Compaction Fires)

```
... conversation grows ...

User sends message
  +-- context event: ctx.getContextUsage() -> 82% -> WRITE CHECKPOINT
      +-- read state files -> bundle into checkpoint YAML
      +-- write checkpoints/<safe_dir>/cp_003.yaml (atomic)
      +-- update _latest.json
      +-- reset state files
      +-- inject gauge: "[Context: 82% | 164k/200k | Checkpoint saved]"

... conversation continues (agent may wrap up) ...

Memory flush triggers (existing)
  +-- separate LLM turn writes memories to memory/*.md

Compaction triggers (~90%)
  +-- session_before_compact fires in compaction-safeguard
      +-- read state files (accumulated since 80% checkpoint)
      +-- if state changed: write updated checkpoint cp_004.yaml
      +-- compaction-safeguard runs LLM summarization (existing)
      +-- return summary as CompactionResult (existing)

Post-compact (agent-runner.ts):
  +-- enqueueSystemEvent(AGENTS.md sections)    (existing)
  +-- enqueueSystemEvent(checkpoint data)       (NEW)
  +-- both arrive as system messages on next turn

Next user message:
  +-- agent sees: LLM summary (glue) + AGENTS.md rules + checkpoint data
  +-- context event: ctx.getContextUsage() -> ~15% (lean!)
  +-- mem0 recalls user memories (independent)
  +-- agent resumes with full continuity
```

### 10.3 New Session (Resume)

```
New session starts for same session_key
  +-- context-manager extension loads
  +-- checks <stateDir>/context/checkpoints/<safe_dir>/_latest.json
  +-- if checkpoint exists: enqueue system event with checkpoint data
  +-- agent receives: structured resume context (~600 tokens)

  +-- mem0 recalls user memories (independent)
      +-- user-level facts (preferences, identity)
      +-- injected via prependContext

  +-- agent has: work-level continuity + user-level memory
```

## 11. Checkpoint Building Logic

### 11.1 What Gets Bundled (at checkpoint write time)

| Data Source | How Captured | Goes Into |
|-------------|-------------|-----------|
| Current conversation topic | Last user message gist (first 100 chars) from message array | `working.topic` |
| Conversation status | Heuristic: recent tool calls = in_progress, no recent activity = idle | `working.status` |
| Interrupted state | From `CompactionPreparation.isSplitTurn` (compaction only) | `working.interrupted` |
| Decisions | Incremental: `decisions.json` accumulated by extension | `decisions[]` |
| Files read/modified | From `CompactionPreparation.fileOps` (compaction) + incremental `resources.json` | `resources` |
| Tools used | Incremental: `resources.json` accumulated by extension tool_result handler | `resources.tools_used` |
| Thread summary | First user message + last user message (truncated) | `thread.summary` |
| Key exchanges | Subsample of user/agent turns (first, pivots, last) | `thread.key_exchanges` |
| Open items | Incremental: `open_items.json` | `open_items` |
| Learnings | Incremental: accumulated in state, written for agent visibility | `learnings` |
| Token usage | From `ctx.getContextUsage()` (primary) or `estimateContextTokens()` (fallback) | `meta.token_usage` |

### 11.2 Thread Extraction (No LLM)

The thread section is built mechanically from the message array available at checkpoint time:

1. **Summary:** First user message (truncated to 100 chars) + " ... " + last user message (truncated to 100 chars)
2. **Key exchanges:** Subsample algorithm:
   - Always include first user message
   - Include any user message that follows a long agent response (>500 chars) -- likely a decision point
   - Always include last 2 user-agent exchange pairs
   - Cap at 8 entries total
   - Each gist is first 120 chars of the message

> **Codex finding #13 addressed:** Approval signal detection (English keywords like "yes", "ok", "approved") has been REMOVED from the thread extraction algorithm. It was English-biased and unreliable for multilingual OpenClaw channels. The structural heuristic (long agent response followed by short user reply) is language-agnostic and sufficient. Approval detection is deferred to a future version that can use lightweight multilingual classification.

No LLM call. Pure string operations on message content.

## 12. Risk Analysis

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Token estimation off -> checkpoint fires too early/late | Low | Medium | Uses SDK `ctx.getContextUsage()` (API metadata, not heuristic). OG compaction at ~95% is safety net |
| Checkpoint file corruption | Low | High | Atomic write (tmp + rename). Linked list via `previous_checkpoint`. Fallback to prior checkpoint |
| YAML parsing adds latency | Low | Low | `yaml` package is <1ms for ~2-3kb files |
| Incremental state files grow unbounded | Low | Medium | Reset at checkpoint write. Cap: 50 decisions, 8 exchanges, 100 tools, 100 files |
| Thread extraction misidentifies decisions | Medium | Low | Supplementary -- agent has full context pre-compact; checkpoint is for post-compact |
| Compaction death spiral (count > 3) | Low | High | Detect via `compaction_count`. Surface warning. Suggest fresh session |
| Process crash before checkpoint | Medium | Medium | State files persist on disk. Next session's first checkpoint bundles them |
| State files stale from previous session | Low | Low | Check `_latest.json` timestamp vs state file timestamps. Discard stale state files |

## 13. Success Criteria

1. **Post-compact reload cost:** ~600-700 tokens (down from ~30-50k)
2. **No LLM calls in checkpoint path:** checkpoint write is pure computation
3. **Backward compatible:** existing compaction continues working; checkpoint is purely additive
4. **mem0 unaffected:** plugin continues independently; no cross-plugin API calls
5. **Agent continuity:** after compaction, agent receives system event with structured resume context
6. **Death spiral detection:** `compaction_count > 3` surfaces a warning
7. **No new dependencies:** uses existing `yaml` package
8. **Windows safe:** all file paths use `sanitizeSessionKeyForPath()`, atomic writes use EPERM fallback

## 14. Out of Scope (v1)

- **Selection pressure / decay formulas** -- valuable but independent. Can be added to core memory system later without touching context manager.
- **Demand-paging** -- requires changes to the context assembler for reference vs inline injection. Deferred to v2.
- **Background consolidation** -- cross-session pattern detection, memory promotion. Deferred to v2.
- **Automatic learnings-to-mem0 routing** -- requires a cross-plugin memory write API that doesn't exist yet. Agent can manually promote via `memory_store` tool. Deferred.
- **SQLite storage backend** -- JSON/YAML files are sufficient for v1. Migrate if query patterns require it.
- **Multilingual approval detection** -- requires lightweight classification. Deferred to v2.
- **`session_end` checkpoint** -- unreliable trigger (only fires on reset/new-session, not process termination). Process exit relies on state files persisting on disk.

## Appendix A: Codex Review Findings Resolution

| # | Severity | Finding | Resolution |
|---|----------|---------|------------|
| 1 | Critical | `session_end` unreliable for final checkpoint | Removed `session_end` dependency. Primary capture: 80% threshold + compaction-safeguard. State files persist for next session. (Section 7.3) |
| 2 | Critical | Extension injection not implementable (`session_start` can't return context) | Changed to `enqueueSystemEvent()` pattern -- same as existing AGENTS.md injection. (Section 8.2) |
| 3 | Critical | Synchronous write conflicts with fire-and-forget hooks | Checkpoint writes happen ONLY in extension events (awaited) and compaction-safeguard (awaited). Plugin hooks NOT used for writes. (Section 8.1) |
| 4 | Critical | Raw session_key as directory name breaks Windows | Added `sanitizeSessionKeyForPath()` -- replaces invalid chars. (Section 5.2) |
| 5 | High | `latest.json` global pointer race-prone | Changed to per-session-key `_latest.json` inside each session directory. (Section 5.2) |
| 6 | High | Wrong file references in spec | All references verified: `extensions.ts` for registration, `resolveContextWindowInfo()` in `context-window-guard.ts`. (Section 8.3) |
| 7 | High | Gauge ignores system prompt overhead | Now uses SDK `ctx.getContextUsage()` which accounts for all overhead. Fallback to `estimateContextTokens()`. (Section 6.1) |
| 8 | High | `after_tool_call` plugin hook missing session identity | Incremental capture uses extension `tool_result` event (has full context), NOT plugin hooks. (Section 7.2) |
| 9 | High | mem0 write API doesn't exist in plugin runtime | Removed automatic routing. Learnings written to checkpoint for manual promotion. (Section 5.3) |
| 10 | High | Spec ignores existing pre/post compaction systems | Full coordination documented: memory flush before, checkpoint inside, injection alongside AGENTS.md. (Section 8.5) |
| 11 | Medium | Parallel store bypasses session tree | Justified: checkpoints MUST survive compaction (which drops JSONL entries). Disk files are the correct choice. (Section 5.6) |
| 12 | Medium | Retention contradictions, missing crash safety | Clarified: immutable write-once files, atomic writes, dedup by token delta, explicit delete of old files. (Section 5.2) |
| 13 | Medium | Thread extraction English-biased | Removed English keyword detection. Structural heuristic only (language-agnostic). (Section 11.2) |
| 14 | Low | `js-yaml` unnecessary | Removed. Uses existing `yaml` package (`^2.8.2`). (Section 5.1) |
