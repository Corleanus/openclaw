# Handoff: Cron Catch-Up Gateway Crash Fix
Date: 2026-02-16
From Session: 1

## What Happened
Echo (the OpenClaw agent) added a "catch-up missed cron runs" feature across 4 source files + 1 schema file. The code is technically correct (build passes, types match, croner API used correctly), but it creates a crash loop on gateway restart.

## The Crash Loop (Root Cause)
1. Both Nasledstvo cron jobs have `catchUp: true` but no `lastRunAtMs` in their state
2. On gateway start, `recomputeNextRuns()` defaults `lastRunAtMs ?? 0` → catch-up ALWAYS triggers
3. `nextRunAtMs` is set to a past timestamp → timer fires immediately (delay=0)
4. 2 expensive LLM agent runs spawn simultaneously (cron lane, sequential but both fire)
5. Echo agent also wakes up on Telegram → 3 concurrent heavyweight operations
6. No `--max-old-space-size` set → silent V8 OOM crash (~2 min after start)
7. Jobs never complete → `lastRunAtMs` never persisted → catch-up triggers again on restart → infinite loop

## Files the Agent Modified (all in src/)
- `src/cron/types.ts` — Added `catchUp?: boolean` to CronJob, CronJobCreate, CronJobPatch
- `src/cron/schedule.ts` — Added `computePreviousRunAtMs()` using croner's `previousRuns()` API
- `src/cron/service/jobs.ts` — Added catch-up logic in `recomputeNextRuns()` (lines 84-91), `createJob()` (line 124), `applyJobPatch()` (lines 155-157)
- `src/gateway/protocol/schema/cron.ts` — Added `catchUp: Type.Optional(Type.Boolean())` to CronJobSchema, CronAddParamsSchema, CronJobPatchSchema
- `src/agents/tools/cron-tool.ts` — NOT changed by agent (force-run schema bug is pre-existing)

## Data File Modified
- `~/.openclaw/cron/jobs.json` — `catchUp: true` added to both Nasledstvo jobs (IDs: fed622d0, 131cd8ca)

## What Needs Fixing

### Fix 1: Catch-up logic bug (CRITICAL — stops crash loop)
**File:** `src/cron/service/jobs.ts`, line 85

**Current (buggy):**
```typescript
const lastRun = job.state.lastRunAtMs ?? 0;
```

**Fix:** Skip catch-up when job has never run (undefined lastRunAtMs means "new job, not a missed run"):
```typescript
const lastRun = job.state.lastRunAtMs;
if (lastRun === undefined) continue;  // never ran → not a missed run, skip catch-up
```

Or alternatively, set `nextRunAtMs = now` instead of `prevScheduled` so the job fires once at current time rather than being perpetually "past":
```typescript
job.state.nextRunAtMs = now;  // instead of: job.state.nextRunAtMs = prevScheduled;
```

The first approach is cleaner — catch-up should only fire for jobs that previously ran and then missed a window, not for brand-new jobs that never ran.

### Fix 2: Memory limit (CRITICAL — prevents OOM)
**File:** `~/.openclaw/gateway.cmd`, line 10

**Current:**
```
"C:\Program Files\nodejs\node.exe" C:\Users\Grigorije\Desktop\Projects\openclaw-main\dist\index.js gateway --port 5555
```

**Fix:**
```
"C:\Program Files\nodejs\node.exe" --max-old-space-size=8192 C:\Users\Grigorije\Desktop\Projects\openclaw-main\dist\index.js gateway --port 5555
```

Note: `gateway install --force` must be re-run after editing gateway.cmd (schtasks hardcodes args at install time — known gotcha from primer).

### Fix 3: Pre-existing cron tool schema bug (LOW PRIORITY)
**File:** `src/agents/tools/cron-tool.ts`, line 37

The `mode` field in the tool schema only allows `["now", "next-heartbeat"]` (wake modes). The `run` action's `mode: "force"/"due"` values are handled at runtime (line 299) but may be rejected by LLM provider schema validation. The agent identified this but didn't fix it.

**Fix:** Add separate mode fields for run vs wake, or expand CRON_WAKE_MODES to include "force"/"due".

### Immediate Unblock (if you want gateway running NOW before code fix)
Remove `"catchUp": true` from both Nasledstvo jobs in `~/.openclaw/cron/jobs.json` (lines 55 and 84). Gateway will start without the crash loop.

## Build State
- `pnpm build` passes (157 files, 0 errors)
- Agent's last successful build wrote new dist/ files
- Gateway needs restart after fix

## Pending from Previous Sessions
- SearXNG web search deep dive (from Feb 12 handoff — still pending)
- 37 pre-existing test failures (unrelated)
- `bind` stale-closure issue in run.ts (low priority)

## First Action Next Session
1. Apply Fix 1 (catch-up logic) in `src/cron/service/jobs.ts`
2. Apply Fix 2 (`--max-old-space-size=8192`) in `~/.openclaw/gateway.cmd`
3. `pnpm build`
4. Restart gateway
5. Verify catch-up doesn't fire spuriously
6. Re-enable `catchUp: true` on Nasledstvo jobs after verifying
