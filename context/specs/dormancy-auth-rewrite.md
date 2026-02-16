# Implementation Spec: Dormancy Fixes + Pair Endpoint Rewrite

## Context

Two features (Agent Dormancy + TOFU Auth) were implemented in session 2, reviewed through 4 rounds (sessions 3-4). Dormancy core is solid but has 3 missing entrypoints and minor hardening needs. The `/pair` endpoint has accumulated design debt through incremental patching and needs a clean rewrite. This spec addresses all known issues in a single pass.

Design decisions D1-D9 settled between user and main agent, refined through Codex spec review.

---

## Part A: Dormancy Fixes (Minor — 5 files)

### A1: Add dormancy gate to native-command entrypoints

Three files dispatch to agents via `resolveAgentRoute()` without a dormancy gate. Full dormancy means nothing gets through — messages, reactions, slash commands, native commands all silently dropped for dormant agents.

**Files to modify:**

**`src/discord/monitor/native-command.ts`** (line ~732)
- Import: `import { applyDormancyGate } from "../../agents/dormancy/gate.js";`
- After `resolveAgentRoute()` call at line ~732, before any dispatch:
```typescript
const route = resolveAgentRoute({ cfg, channel: "discord", accountId, ... });
// INSERT AFTER:
const dormancyResult = applyDormancyGate({ agentId: route.agentId, messageTimestamp: undefined });
if (!dormancyResult.shouldProcess) return;
```
- `messageTimestamp: undefined` — native commands don't have a channel message timestamp

**`src/slack/monitor/slash.ts`** (line ~370)
- Import: `import { applyDormancyGate } from "../../agents/dormancy/gate.js";`
- After `resolveAgentRoute()` call at line ~370:
```typescript
const route = resolveAgentRoute({ cfg, channel: "slack", accountId: account.accountId, ... });
// INSERT AFTER:
const dormancyResult = applyDormancyGate({ agentId: route.agentId, messageTimestamp: undefined });
if (!dormancyResult.shouldProcess) return;
```

**`src/telegram/bot-native-commands.ts`** (line ~472)
- Import: `import { applyDormancyGate } from "../agents/dormancy/gate.js";`
- After `resolveAgentRoute()` call at line ~472:
```typescript
const route = resolveAgentRoute({ cfg, channel: "telegram", accountId, ... });
// INSERT AFTER:
const dormancyResult = applyDormancyGate({ agentId: route.agentId, messageTimestamp: undefined });
if (!dormancyResult.shouldProcess) return;
```
- NOTE: There's also a `resolveAgentRoute()` at line ~294 used for skill command discovery (not dispatch). That one does NOT need a gate — it only resolves which agent to check for skills, doesn't process messages.

**Convention:** Same pattern as all other 19 gate insertions. Direct import from `../../agents/dormancy/gate.js` (core files, not extension plugin runtime).

**Verification:** After implementation, `grep -r "resolveAgentRoute" src/` and confirm every call site that dispatches to an agent has a dormancy gate. Call sites that only resolve for metadata/discovery (no message processing) do NOT need gates.

### A2: Harden store.ts validation (D2, D3)

**File:** `src/agents/dormancy/store.ts`

In `loadDormancyState()`, the current nullish coalescing (`??`) doesn't catch wrong types. Change lines 44-50:

```typescript
// CURRENT:
return {
  version: 1,
  dormant: state.dormant ?? false,
  updatedAt: state.updatedAt ?? new Date().toISOString(),
  activatedAt: state.activatedAt ?? null,
  changedBy: state.changedBy ?? null,
};

// REPLACE WITH:
return {
  version: 1,
  dormant: state.dormant === true,  // D3: strict boolean check
  updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
  activatedAt: isValidIsoDate(state.activatedAt) ? state.activatedAt : null,  // D2: validate cursor
  changedBy: typeof state.changedBy === "string" ? state.changedBy : null,
};
```

Add helper at top of file (after imports):
```typescript
function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}
```

### A3: Fix mojibake in types.ts (D4)

**File:** `src/agents/dormancy/types.ts`

Check line 5 for garbled non-ASCII characters. If present, replace with plain ASCII:
```typescript
// If line contains mojibake, replace with:
activatedAt: string | null; // cursor - messages before this are ignored
```

---

## Part B: Pair Endpoint Rewrite (Major — 5 files rewritten/new, 4 files modified)

### B0: Design Summary

The `/pair` endpoint enables TOFU auth: new devices connect, provide password, enter pending state, user approves via main agent. Key changes from current implementation:

1. **Password first gate** — optional, enables WAN without VPN
2. **3-strike persistent IP ban** — wrong password 3 times = permanent ban, unban via main agent tool or admin client RPC
3. **Strip role/scopes from HTTP /pair/request** — pairing is just "this key = this device"
4. **Pairing resolution store** — tracks approved/rejected requests so /pair/status works after pending entry deletion
5. **Fix /pair/status** — no device existence leakage, match requestId + deviceId, check resolution store
6. **Separate rate limiting** — full limits on /pair/request, lightweight on /pair/status
7. **Accurate Retry-After** — derived from config, not hardcoded
8. **WS password gate** — approval bypass checks password when configured
9. **Single ban manager instance** — shared across HTTP + WS, accessed by main agent tool (conditional registration) and admin clients via gateway RPC

### B1: Config type changes

**File:** `src/config/types.gateway.ts`

Replace `GatewayApprovalConfig`:
```typescript
export type GatewayApprovalConfig = {
  /** Password required for pairing requests (optional — if set, enables WAN-safe mode). */
  password?: string;
  /** Max failed auth attempts per IP before permanent ban (default: 3). */
  maxAuthFailures?: number;
  /** Max pending pairing requests per IP (default: 5). */
  maxPendingPerIp?: number;
  /** Cooldown between pairing requests from same IP in ms (default: 10000). */
  cooldownMs?: number;
  /** Max total pending requests across all IPs (default: 20). */
  maxPendingTotal?: number;
  /** Sliding window duration in ms for request rate limiting (default: 60000). */
  windowMs?: number;
  /** Max requests per sliding window per IP (default: 10). */
  maxRequestsPerWindow?: number;
};
```

Changes from current:
- Added `password`, `maxAuthFailures`
- Dropped `username` (WS schema doesn't support it — password-only keeps HTTP and WS consistent)
- Renamed `rateLimitCooldownMs` → `cooldownMs` (cleaner — keep old name as Zod alias for backward compat)
- Added `windowMs`, `maxRequestsPerWindow` (were hardcoded, now configurable)

**File:** `src/config/zod-schema.ts`
- Add `password: z.string().regex(/^[\x20-\x7E]+$/, "Password must be ASCII printable characters").min(1).optional()` (ASCII-only for defense in depth and UX clarity — safeEqual is hardened in B7 but ASCII keeps config predictable)
- Add `maxAuthFailures: z.number().int().min(1).max(10).optional()`
- Add `windowMs: z.number().int().min(1000).optional()`, `maxRequestsPerWindow: z.number().int().min(1).optional()`
- Add `cooldownMs` as the primary key. Keep `rateLimitCooldownMs` as a Zod `.transform()` alias that maps to `cooldownMs` for backward compatibility (existing configs won't break)

### B2: Ban storage (NEW FILE)

**File:** `src/gateway/pair-ban.ts`

Persistent IP ban storage. Single instance per gateway process. Pattern follows `src/infra/json-file.ts`.

```typescript
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import path from "node:path";

export type BanRecord = {
  ip: string;
  failureCount: number;
  bannedAt: string | null;  // ISO timestamp, null if not yet banned
  lastFailureAt: string;    // ISO timestamp
};

type BanStore = {
  version: 1;
  records: Record<string, BanRecord>;  // keyed by IP
};

const BAN_FILE = path.join(STATE_DIR, "gateway", "pair-bans.json");

export type PairBanManager = {
  isBanned(ip: string): boolean;
  recordFailure(ip: string): { banned: boolean; failureCount: number };
  unban(ip: string): boolean;
  listBanned(): BanRecord[];
};

export function createPairBanManager(opts?: {
  maxFailures?: number;
}): PairBanManager {
  const maxFailures = opts?.maxFailures ?? 3;

  // Load from disk on creation
  let store = loadStore();

  function loadStore(): BanStore {
    const raw = loadJsonFile(BAN_FILE);
    if (raw && typeof raw === "object" && (raw as any).version === 1) {
      return raw as BanStore;
    }
    return { version: 1, records: {} };
  }

  function persist(): void {
    saveJsonFile(BAN_FILE, store);
  }

  function isBanned(ip: string): boolean {
    return store.records[ip]?.bannedAt !== null && store.records[ip]?.bannedAt !== undefined;
  }

  function recordFailure(ip: string): { banned: boolean; failureCount: number } {
    const now = new Date().toISOString();
    const existing = store.records[ip];
    const failureCount = (existing?.failureCount ?? 0) + 1;
    const banned = failureCount >= maxFailures;

    store.records[ip] = {
      ip,
      failureCount,
      bannedAt: banned ? now : null,
      lastFailureAt: now,
    };
    persist();

    return { banned, failureCount };
  }

  function unban(ip: string): boolean {
    if (!store.records[ip]) return false;
    delete store.records[ip];
    persist();
    return true;
  }

  function listBanned(): BanRecord[] {
    return Object.values(store.records).filter((r) => r.bannedAt !== null);
  }

  return { isBanned, recordFailure, unban, listBanned };
}
```

Storage: `~/.openclaw/gateway/pair-bans.json`

**CRITICAL:** Only ONE instance per gateway process. Created at gateway runtime level (NOT per-HTTP-server). Multiple HTTP servers (IPv4 + IPv6) share the same instance. Passed into both `createPairHttpHandler()` and `attachGatewayWsMessageHandler()`.

### B3: Rate limiter rewrite

**File:** `src/gateway/pair-rate-limit.ts` (REWRITE)

Simplified. Ban logic is separate (pair-ban.ts). Rate limiter only handles request volume.

```typescript
export type PairRateLimiter = {
  /** Full check for /pair/request — pendingCount + cooldown + window. Returns retryAfterSeconds for 429 header. */
  checkRequest(ip: string): { ok: boolean; retryAfterSeconds: number };
  /** Lightweight check for /pair/status — window only, no cooldown. Returns retryAfterSeconds for 429 header. */
  checkStatus(ip: string): { ok: boolean; retryAfterSeconds: number };
  /** Record a /pair/request attempt (updates cooldown + window). Called immediately after checkRequest passes. */
  recordRequest(ip: string): void;
  /** Record a /pair/status request in the window. Called immediately after checkStatus passes. */
  recordStatus(ip: string): void;
  /** Track in-flight pairing operation (increments pendingCount). */
  track(ip: string): void;
  /** Release in-flight pairing operation (decrements pendingCount). */
  release(ip: string): void;
  /** Clean up expired entries. */
  prune(): void;
  /** Get cooldown seconds for Retry-After header. */
  getCooldownSeconds(): number;
};

type IpState = {
  pendingCount: number;
  lastRequestMs: number;
  requestsInWindow: number[];
  statusRequestsInWindow: number[];  // separate window for status
};

export function createPairRateLimiter(opts?: {
  maxPendingPerIp?: number;
  cooldownMs?: number;
  maxPendingTotal?: number;
  windowMs?: number;
  maxRequestsPerWindow?: number;
}): PairRateLimiter {
  const maxPendingPerIp = opts?.maxPendingPerIp ?? 5;
  const cooldownMs = opts?.cooldownMs ?? 10_000;
  const maxPendingTotal = opts?.maxPendingTotal ?? 20;
  const windowMs = opts?.windowMs ?? 60_000;
  const maxRequestsPerWindow = opts?.maxRequestsPerWindow ?? 10;

  const ipStates = new Map<string, IpState>();

  function getOrCreateState(ip: string): IpState {
    let state = ipStates.get(ip);
    if (!state) {
      state = { pendingCount: 0, lastRequestMs: 0, requestsInWindow: [], statusRequestsInWindow: [] };
      ipStates.set(ip, state);
    }
    return state;
  }

  function getTotalPending(): number {
    let total = 0;
    for (const state of ipStates.values()) total += state.pendingCount;
    return total;
  }

  function checkRequest(ip: string): { ok: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const state = getOrCreateState(ip);
    const cooldownSeconds = Math.ceil(cooldownMs / 1000);
    if (state.pendingCount >= maxPendingPerIp) return { ok: false, retryAfterSeconds: cooldownSeconds };
    if (getTotalPending() >= maxPendingTotal) return { ok: false, retryAfterSeconds: cooldownSeconds };
    const cooldownRemaining = cooldownMs - (now - state.lastRequestMs);
    if (cooldownRemaining > 0) return { ok: false, retryAfterSeconds: Math.ceil(cooldownRemaining / 1000) };
    state.requestsInWindow = state.requestsInWindow.filter((ts) => ts > now - windowMs);
    if (state.requestsInWindow.length >= maxRequestsPerWindow) {
      const oldestInWindow = state.requestsInWindow[0] ?? now;
      const windowRemaining = windowMs - (now - oldestInWindow);
      return { ok: false, retryAfterSeconds: Math.ceil(windowRemaining / 1000) };
    }
    return { ok: true, retryAfterSeconds: 0 };
  }

  function checkStatus(ip: string): { ok: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const state = getOrCreateState(ip);
    state.statusRequestsInWindow = state.statusRequestsInWindow.filter((ts) => ts > now - windowMs);
    // 3x the normal window limit — supports 3s polling (~20/min fits within 30 limit)
    if (state.statusRequestsInWindow.length >= maxRequestsPerWindow * 3) {
      const oldestInWindow = state.statusRequestsInWindow[0] ?? now;
      const windowRemaining = windowMs - (now - oldestInWindow);
      return { ok: false, retryAfterSeconds: Math.ceil(windowRemaining / 1000) };
    }
    return { ok: true, retryAfterSeconds: 0 };
  }

  function recordRequest(ip: string): void {
    const now = Date.now();
    const state = getOrCreateState(ip);
    state.lastRequestMs = now;
    state.requestsInWindow.push(now);
  }

  function recordStatus(ip: string): void {
    const now = Date.now();
    const state = getOrCreateState(ip);
    state.statusRequestsInWindow.push(now);
  }

  function track(ip: string): void {
    const state = getOrCreateState(ip);
    state.pendingCount++;
  }

  function release(ip: string): void {
    const state = ipStates.get(ip);
    if (state && state.pendingCount > 0) state.pendingCount--;
  }

  function prune(): void {
    const now = Date.now();
    const windowStart = now - windowMs;
    for (const [ip, state] of ipStates.entries()) {
      state.requestsInWindow = state.requestsInWindow.filter((ts) => ts > windowStart);
      state.statusRequestsInWindow = state.statusRequestsInWindow.filter((ts) => ts > windowStart);
      if (state.pendingCount === 0 && state.requestsInWindow.length === 0 && state.statusRequestsInWindow.length === 0) {
        ipStates.delete(ip);
      }
    }
  }

  function getCooldownSeconds(): number {
    return Math.ceil(cooldownMs / 1000);
  }

  return { checkRequest, checkStatus, recordRequest, recordStatus, track, release, prune, getCooldownSeconds };
}
```

Key changes from current:
- `check()` split into `checkRequest()` and `checkStatus()` — separate windows
- Added `recordStatus()` — status requests ARE counted against their own window (Codex finding: without recording, status is unbounded)
- `recordRequest()` replaces `recordAttempt()` — only for /pair/request
- Status polling gets separate window with 3x limit, no cooldown — supports 3s polling
- `getCooldownSeconds()` retained as internal utility (used by `checkRequest()` for pending/total limit retryAfterSeconds). Callers use `checkResult.retryAfterSeconds` from the check methods, not `getCooldownSeconds()` directly
- Ban logic removed (lives in pair-ban.ts)

### B4: Pairing resolution store (NEW — extends existing file)

**File:** `src/infra/device-pairing.ts` (MODIFY)

**Problem:** When a pairing request is approved/rejected, the pending entry is deleted (`src/infra/device-pairing.ts:341` and `:358-359`). So `/pair/status` cannot determine the outcome of a request after approval without calling `getPairedDevice()` directly (which leaks device existence).

**Solution:** Add a `resolved.json` store alongside existing `pending.json`/`paired.json`.

**Type:**
```typescript
type DevicePairingResolution = {
  requestId: string;
  deviceId: string;
  decision: "approved" | "rejected";
  resolvedAtMs: number;
};
```

**Write rules:**
- In `approveDevicePairing()`: after removing from pending, record `resolved[requestId] = { requestId, deviceId, decision: "approved", resolvedAtMs: Date.now() }`
- In `rejectDevicePairing()`: after removing from pending, record `resolved[requestId] = { requestId, deviceId, decision: "rejected", resolvedAtMs: Date.now() }`
- Keep resolved entries for 24h TTL — prune entries older than 24h on load

**Read API (new export):**
```typescript
export async function getDevicePairingResolution(requestId: string): Promise<DevicePairingResolution | null>;
```

Note: async to match existing device-pairing I/O patterns. Prune 24h-old entries on load AND persist the pruned result to prevent unbounded file growth.

**Storage:** `<STATE_DIR>/devices/resolved.json` (alongside existing device pairing state)

### B4b: Pair HTTP handler rewrite

**File:** `src/gateway/pair-http.ts` (REWRITE)

**Handler flow for `/pair/request`:**
```
1. Resolve client IP
2. Check ban → 403 "forbidden" if banned
3. checkRequest(ip) → 429 if !ok (Retry-After: checkResult.retryAfterSeconds)
4. recordRequest(ip) ← IMMEDIATELY after check passes, before body read (Codex: prevents crypto/parse abuse)
5. Read body (64KB limit)
6. Validate password (if configured) → 401 "unauthorized" if wrong + banManager.recordFailure(ip)
7. Validate required fields: deviceId, publicKey, signature, signedAt
8. Validate device identity: deriveDeviceIdFromPublicKey, verifyDeviceSignature
9. Validate clock skew (60s)
10. track(ip) for pendingCount
11. try { requestDevicePairing({ deviceId, publicKey, displayName?, platform?, remoteIp, silent: false }) } finally { release(ip) }
12. Return { status: "pending", requestId }
```

Note step 4: Rate limit recorded BEFORE body read. Invalid requests (bad JSON, wrong password, bad signature) still consume rate limit budget. This prevents attackers from forcing repeated parsing/crypto without counting against limits.

Note step 6: Password check uses `safeEqual()` from `src/gateway/auth.ts:37-42` (existing helper — length check + timingSafeEqual with Buffer.from). Do NOT roll a new comparison function.

Note step 11: `role`, `scopes`, `clientId`, `clientMode` are NOT extracted from the HTTP request body. Instead, HTTP-originated pairings use server-assigned defaults: `role: "operator"`, `scopes: ["operator.admin"]`. This is a single-operator personal system — every HTTP-paired device is the owner's device. WS path keeps client-provided role/scopes because they're signed there via `buildDeviceAuthPayload()` and the WS flow supports node devices with `role: "node"`.

The pairing request passed to `requestDevicePairing()` from HTTP:
```typescript
{
  deviceId,
  publicKey,
  displayName: /* from client metadata, unsigned hint */,
  platform: /* from client metadata, unsigned hint */,
  role: "operator",           // server-assigned default
  scopes: ["operator.admin"], // server-assigned default
  remoteIp,
  silent: false,
}
```

**Handler flow for `/pair/status`:**
```
1. Resolve client IP
2. Check ban → 403 "forbidden" if banned
3. checkStatus(ip) → 429 if limited
4. recordStatus(ip) ← IMMEDIATELY after check passes
5. Read body (64KB limit)
6. Validate password (if configured) → 401 "unauthorized" if wrong + banManager.recordFailure(ip)
7. Validate required fields: requestId, deviceId
8. Check resolved store: getDevicePairingResolution(requestId)
   - If found AND resolved.deviceId === deviceId:
     - decision "approved" → { status: "approved" }
     - decision "rejected" → { status: "rejected" }
   - If found AND deviceId mismatch → { status: "unknown" }
9. Check pending: find pending request matching BOTH requestId AND deviceId
   - If found → { status: "pending", retryAfterMs: 3000 }
10. Else → { status: "unknown" }
```

**SECURITY INVARIANT:** `/pair/status` MUST NOT call `getPairedDevice(deviceId)` independently. Only the resolution store (keyed by requestId, validated against deviceId) determines outcomes. This eliminates the device existence oracle.

**Password validation:**
```typescript
import { safeEqual } from "./auth.js";  // existing helper at src/gateway/auth.ts:37-42

function validatePassword(
  body: Record<string, unknown>,
  approvalConfig: GatewayApprovalConfig | undefined,
): boolean {
  const configuredPassword = approvalConfig?.password;
  if (!configuredPassword) return true;  // no password configured = LAN-only mode, skip check
  const provided = typeof body.password === "string" ? body.password : "";
  return safeEqual(provided, configuredPassword);
}
```

**Error responses (minimal information):**
- Ban: `403 { ok: false, error: "forbidden" }` — no detail about why
- Rate limit: `429 { ok: false, error: "rate limit exceeded" }` with `Retry-After: <checkResult.retryAfterSeconds>` (from checkRequest/checkStatus return value)
- Auth failure: `401 { ok: false, error: "unauthorized" }` — no detail about which field
- Body too large: `413 { ok: false, error: "payload too large" }`
- Invalid body: `400 { ok: false, error: "invalid request body" }`
- Missing fields: `400 { ok: false, error: "required fields missing" }` — don't enumerate which fields

**Function signature update:**
```typescript
export function createPairHttpHandler(opts: {
  resolvedAuth: ResolvedGatewayAuth;
  rateLimiter: PairRateLimiter;
  banManager: PairBanManager;
  trustedProxies?: string[];
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean>
```

**What stays the same:**
- `readJsonBody()` helper with 64KB limit
- `sendJson()` and `send429()` helpers
- `headerValue()` helper
- `resolveGatewayClientIp()` usage
- All device identity functions (deriveDeviceIdFromPublicKey, verifyDeviceSignature)

### B5: Server wiring — single ban manager instance

**File:** `src/gateway/server-http.ts` (MODIFY)

**CRITICAL ARCHITECTURE:** Ban manager and rate limiter must be created ONCE at gateway runtime level, NOT per-HTTP-server. Multiple HTTP servers (127.0.0.1 and ::1 bind) would create duplicate instances with diverging state.

The ban manager should be created in the gateway runtime state and passed down. Find where `createGatewayHttpServer()` is called (likely `src/gateway/server-runtime-state.ts` or `src/gateway/server-startup.ts`) and create ban manager + rate limiter there, then pass as params.

```typescript
import { createPairBanManager } from "./pair-ban.js";

// At gateway runtime level (NOT inside createGatewayHttpServer):
const approvalConfig = resolvedAuth.approval;
const pairBanManager = createPairBanManager({
  maxFailures: approvalConfig?.maxAuthFailures,
});
const pairRateLimiter = createPairRateLimiter({
  maxPendingPerIp: approvalConfig?.maxPendingPerIp,
  cooldownMs: approvalConfig?.cooldownMs,
  maxPendingTotal: approvalConfig?.maxPendingTotal,
  windowMs: approvalConfig?.windowMs,
  maxRequestsPerWindow: approvalConfig?.maxRequestsPerWindow,
});

// Pass to HTTP handler creation:
const pairHandler = createPairHttpHandler({
  resolvedAuth,
  rateLimiter: pairRateLimiter,
  banManager: pairBanManager,
  trustedProxies,
});
```

The same `pairBanManager` instance must also be passed to the WS handler (B6).

**Prune timer:** Start a single `setInterval(pairRateLimiter.prune, 60_000)` at the same gateway runtime level where the limiter is created. Clear the interval on gateway shutdown. Do NOT create prune timers inside `createGatewayHttpServer()` — multiple HTTP servers would create duplicate timers.

### B6: WS message handler — password gate + ban check

**File:** `src/gateway/server/ws-connection/message-handler.ts` (MODIFY)

**Context from Codex investigation:**
- WS schema at `src/gateway/protocol/schema/frames.ts:55-63` defines `auth: { token?: string; password?: string }` — no username field, `additionalProperties: false`
- Handler reads `connectParams.auth?.password` at lines 403-405
- Client IP is `clientIp` computed at lines 194-196 via `resolveGatewayClientIp()`
- The approval bypass is at lines 673-679

**Plumbing:** Add `banManager: PairBanManager` to `attachGatewayWsMessageHandler()` params (defined at lines 133-162). Pass from `src/gateway/server/ws-connection.ts` (lines ~230-260).

**Ban check inside approval bypass only** (NOT early in connect handler — early ban would block already-paired devices reconnecting from a banned IP, which is wrong):

**Replace approval bypass (lines 673-679):**
```typescript
if (!authOk && resolvedAuth.mode === "approval" && device && devicePublicKey) {
  // Ban check — only for approval mode bypass, not for device-token auth
  if (banManager.isBanned(clientIp)) {
    close(1008, "Policy violation");  // use injected close(), not ws.close()
    return;
  }

  const approval = resolvedAuth.approval;
  const configuredPassword = typeof approval?.password === "string" && approval.password.length > 0;

  if (configuredPassword) {
    const provided = typeof connectParams.auth?.password === "string" ? connectParams.auth.password : "";
    if (!safeEqual(provided, approval!.password!)) {
      banManager.recordFailure(clientIp);
      rejectUnauthorized();
      return;
    }
  }

  authOk = true;
  authMethod = "approval";
}
```

Uses `safeEqual` from `src/gateway/auth.ts:37-42` (already imported in this file or importable).

**WS client credential sourcing:** When `gateway.auth.approval.password` is set, WS clients (CLI, tools, Control UI) need to send it as `auth.password` in the connect message. The gateway client code at `src/gateway/call.ts:134-180` and `src/gateway/client.ts:187-199` sources `auth.password` from `gateway.auth.password` and env vars. For approval mode, implementers must ensure that either:
- `gateway.auth.approval.password` is also read as the WS auth password source when mode is "approval", OR
- Document that `OPENCLAW_GATEWAY_PASSWORD` env var should be set to match `gateway.auth.approval.password` for CLI/tool access

**Recommended approach:** In the gateway client connection logic, when `resolvedAuth.mode === "approval"` and `resolvedAuth.approval?.password` exists, use that as the WS auth password. This keeps it automatic — no env var needed.

**Role/scopes on WS path:** Keep as-is. WS pairing passes role/scopes to `requestDevicePairing()` at lines 695-696 because they're part of the signed `buildDeviceAuthPayload()` at lines 584-595. Stripping them would break the role-upgrade/scope-upgrade pairing flow at lines 750-781.

### B7: Auth module — export + harden safeEqual

**File:** `src/gateway/auth.ts`

`resolveGatewayAuth()` needs no change — the approval branch already passes `authConfig.approval` through, and `GatewayApprovalConfig` type changes (B1) flow through automatically.

**Action required:**
1. `safeEqual` at lines 37-42 is currently NOT exported. Add `export` to the function declaration. It will be imported by pair-http.ts and message-handler.ts.
2. **Harden `safeEqual()` to use byte-length comparison.** Current implementation checks `a.length === b.length` (string length), but `timingSafeEqual` requires equal *byte* lengths. A client can send non-ASCII input with matching string length but different byte length, causing a `RangeError` crash. Fix:
```typescript
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
```
This fixes the crash path for ALL call sites (approval password, token auth, password auth) — not just the new ones.

**Note on approval password config:** Additionally restrict approval password to ASCII in Zod schema (`z.string().regex(/^[\x20-\x7E]+$/).min(1).optional()`) for defense in depth. The hardened `safeEqual()` handles any input safely, but ASCII-only config prevents accidental encoding issues.

---

## Part C: Ban Management — Gateway RPC + Agent Tool

### C1: Gateway RPC methods (NEW)

**Files:** Register as `extraHandlers` closures in `src/gateway/server.impl.ts` (lines ~472-489), same pattern used for other runtime-dependent methods. The closures capture the `pairBanManager` singleton.

New gateway methods for ban management:
- `gateway.security.bans.list` → returns `BanRecord[]`
- `gateway.security.bans.unban` → takes `{ ip: string }`, returns `{ ok: boolean }`

These call the single `PairBanManager` instance directly — no stale cache issue since it's the same in-memory instance the HTTP/WS handlers use.

**Access control:** `authorizeGatewayMethod()` at `src/gateway/server-methods.ts:159` defaults unknown methods to `operator.admin` — so `gateway.security.bans.*` methods are admin-only automatically. If they should appear in the gateway hello features list, add them to `src/gateway/server-methods-list.ts`.

### C2: Agent tool (NEW FILE)

**File:** `src/agents/tools/gateway-security-tool.ts`

Tool for main agent to manage approval security. Actions:
- `list_banned` — calls `gateway.security.bans.list` RPC
- `unban` — calls `gateway.security.bans.unban` RPC (user confirms via normal tool approval flow)
- `reset_password` — updates `gateway.auth.approval.password` via `writeConfigFile()`

**IMPORTANT:** `reset_password` triggers a gateway restart (all `gateway.*` config changes do — see `src/gateway/config-reload.ts:80-85`). The tool should warn the user: "Changing the approval password will restart the gateway. Active connections will be dropped."

**Schema:** Use `stringEnum(["list_banned", "unban", "reset_password"])` for action parameter.

**Registration:** Add to `src/agents/openclaw-tools.ts`. Available to main agent only — enforce via `resolveSessionAgentId({ sessionKey, config }) === DEFAULT_AGENT_ID` check (see `src/agents/agent-scope.ts:87-92`, `src/routing/session-key.ts:10`). Register the tool conditionally so non-main agents never see it.

---

## Design Decisions Record

| # | Decision | Resolution | Why |
|---|----------|------------|-----|
| D1 | Dormant agents + native commands | Full dormancy — gate ALL entrypoints | Slash commands can be abused by anyone who sends messages to the channel |
| D2 | Invalid `activatedAt` | Validate on load, treat invalid as `null` | Prevents NaN ghost in cursor check, improves debuggability |
| D3 | Non-boolean `dormant` | Strict: `state.dormant === true` | JS truthiness makes `0` and `""` falsy = "active", which is wrong |
| D4 | Mojibake in types.ts | Fix to plain ASCII | Cosmetic |
| D5 | Auth model | Password-only (no username — WS schema can't carry it). Optional — LAN works without password. | Consistent across HTTP and WS paths |
| D5b | WAN safety | Password + 3-strike permanent ban + manual approval = WAN-safe without VPN | User in the loop IS the security |
| D6 | /pair/status leaking | Resolution store keyed by requestId, never call getPairedDevice() directly | Eliminates device existence oracle |
| D7 | Status lookup ignoring deviceId | Match BOTH requestId AND deviceId | Prevents requestId-based enumeration |
| D8 | Rate limiting status vs request | Separate check/record methods, separate windows. Status: 3x limit, no cooldown. | Supports 3s polling without affecting request security |
| D9 | Retry-After hardcoded | Derive from `checkResult.retryAfterSeconds` returned by `checkRequest()`/`checkStatus()` | Accuracy — each check returns the exact remaining time |
| D10 | Role/scopes HTTP vs WS | Strip from HTTP /pair/request, keep on WS (signed there) | HTTP unsigned = tamperable. WS signed via buildDeviceAuthPayload() = safe |
| D11 | Ban manager architecture | Single instance per process, RPC for tool access | Avoids stale cache, avoids multi-instance divergence |
| D12 | Credential comparison | Use existing safeEqual() from src/gateway/auth.ts | Don't reinvent timing-safe comparison |
| D13 | Credential reset | writeConfigFile() triggers gateway restart | Document in tool UX, not a bug |
| D14 | HTTP-paired device privileges | Server-assigned defaults: role="operator", scopes=["operator.admin"] | Single-operator system — every HTTP-paired device is the owner's device |
| D15 | Password character set | ASCII-only (printable 0x20-0x7E) enforced in Zod | Defense in depth + UX clarity (safeEqual hardened in B7, but ASCII keeps config predictable) |
| D16 | WS ban scope | Ban check inside approval bypass only, not early in connect | Already-paired devices with device-token should reconnect even from banned IP |

## Accepted Risks (NOT addressing)

- Signature replay within 60s window — dedup in requestDevicePairing prevents abuse
- Client display fields (displayName, platform) in /pair/request are unsigned hints — user sees and approves manually, no privilege implications
- POST for /pair/status (not GET) — intentional, avoids URL-logged credentials
- WS role/scopes in pairing request — signed via buildDeviceAuthPayload(), not tamperable on WS path

---

## File Summary

| File | Action | Part |
|------|--------|------|
| `src/discord/monitor/native-command.ts` | ADD dormancy gate | A1 |
| `src/slack/monitor/slash.ts` | ADD dormancy gate | A1 |
| `src/telegram/bot-native-commands.ts` | ADD dormancy gate | A1 |
| `src/agents/dormancy/store.ts` | MODIFY validation | A2 |
| `src/agents/dormancy/types.ts` | FIX mojibake | A3 |
| `src/config/types.gateway.ts` | MODIFY GatewayApprovalConfig | B1 |
| `src/config/zod-schema.ts` | MODIFY approval schema | B1 |
| `src/gateway/pair-ban.ts` | NEW ban storage | B2 |
| `src/gateway/pair-rate-limit.ts` | REWRITE | B3 |
| `src/infra/device-pairing.ts` | MODIFY — add resolution store | B4 |
| `src/gateway/pair-http.ts` | REWRITE | B4b |
| `src/gateway/server-http.ts` (or runtime-state) | MODIFY — single instance wiring | B5 |
| `src/gateway/server/ws-connection/message-handler.ts` | MODIFY — password gate + ban | B6 |
| `src/gateway/server/ws-connection.ts` | MODIFY — plumb banManager | B6 |
| `src/gateway/auth.ts` | MODIFY — export + harden safeEqual | B7 |
| Gateway method registration files | ADD security.bans.* methods | C1 |
| `src/agents/tools/gateway-security-tool.ts` | NEW ban management tool | C2 |
| `src/agents/openclaw-tools.ts` | MODIFY — register tool | C2 |

## Conventions Reference

- **ID normalization:** Always use `normalizeAgentId()` from `src/routing/session-key.ts`
- **Tool schemas:** Use `stringEnum()` from `src/agents/schema/typebox.js`, NOT `Type.Union`
- **File persistence:** Use `loadJsonFile`/`saveJsonFile` from `src/infra/json-file.ts`
- **State directory:** `STATE_DIR` from `src/config/paths.ts` (resolves to `~/.openclaw`)
- **Timing-safe comparison:** Use `safeEqual()` from `src/gateway/auth.ts` — do NOT roll new helpers
- **Dormancy gate pattern:** After `resolveAgentRoute()`, before any dispatch. Direct import for core files, plugin runtime API for extensions
- **Error responses:** Minimal information — never reveal internal state or which field was wrong for auth failures
- **Gateway method access control:** Ban management methods are admin-only (same pattern as config.*, update.*)
