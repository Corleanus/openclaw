# Fix Spec: Codex Review Findings

Source: 11-module Codex review of dormancy-auth-rewrite implementation.

---

## Fix 1 (Module 5): Ban storage hardening — `src/gateway/pair-ban.ts`

### F1a: Validate `records` field on load
`loadStore()` only checks `version === 1` then casts. If JSON has `{"version":1}` but no `records`, accessing `store.records[ip]` throws.

**Fix:** Add validation:
```typescript
function loadStore(): BanStore {
  const raw = loadJsonFile(BAN_FILE);
  if (raw && typeof raw === "object" && (raw as any).version === 1 && typeof (raw as any).records === "object" && (raw as any).records !== null) {
    return raw as BanStore;
  }
  return { version: 1, records: {} };
}
```

### F1b: Don't overwrite `bannedAt` on repeated failures
Currently `recordFailure()` overwrites `bannedAt` every call once threshold is reached, losing the original ban timestamp.

**Fix:** Preserve existing `bannedAt` if already banned:
```typescript
function recordFailure(ip: string): { banned: boolean; failureCount: number } {
  const now = new Date().toISOString();
  const existing = store.records[ip];
  if (existing?.bannedAt) {
    return { banned: true, failureCount: existing.failureCount }; // already banned, don't touch
  }
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
```

### F1c: Guard against accidental unban from config change
If `maxFailures` increases between runs, an IP with `failureCount < newMaxFailures` but `bannedAt` set would be in an inconsistent state. The F1b fix handles this — once `bannedAt` is set, `recordFailure` returns early.

`isBanned()` checks `bannedAt`, not `failureCount >= maxFailures`, so config changes don't accidentally unban.

No additional code change needed — F1b covers this.

---

## Fix 2 (Module 8): HTTP handler — `src/gateway/pair-http.ts`

### F2a: Null body guard (CRITICAL)
JSON `null` is valid JSON but `null as Record<string, unknown>` causes property access to throw → 500.

**Fix:** After `readJsonBody()` succeeds, add type guard:
```typescript
const bodyResult = await readJsonBody(req);
if (!bodyResult.ok) { /* existing error handling */ }
const body = bodyResult.value;
if (!body || typeof body !== "object" || Array.isArray(body)) {
  sendJson(res, 400, { ok: false, error: "invalid request body" });
  return true;
}
```
Apply this in BOTH `handlePairRequest` and `handlePairStatus` (or in a shared validation step).

### F2b: readJsonBody hang on disconnect (HIGH)
If client disconnects and Node emits `"close"` without `"error"`, the promise never resolves.

**Fix:** Add `"close"` listener to `readJsonBody()`:
```typescript
req.on("close", () => {
  if (done) return;
  done = true;
  resolve({ ok: false, error: "connection closed" });
});
```
Add this after the existing `req.on("error", ...)` handler.

---

## Fix 3 (Module 9): Server wiring — `src/gateway/server-runtime-state.ts`

### F3: Return prune timer for shutdown cleanup
`pruneTimer` is created but not returned, so `createGatewayCloseHandler()` can't clear it. Repeated in-process restarts leak intervals.

**Fix:** Return `pruneTimer` from `createGatewayRuntimeState()` and clear it in the close handler:
1. Add `pruneTimer` to the return value of `createGatewayRuntimeState()`
2. In `createGatewayCloseHandler()` (server-close.ts), accept and `clearInterval(pruneTimer)`

---

## Fix 4 (Module 10): WS gate — `src/gateway/server/ws-connection/message-handler.ts`

### F4: Guard `clientIp` undefined before ban operations
`resolveGatewayClientIp()` returns `string | undefined`. Passing `undefined` to `banManager.isBanned()` creates records keyed `"undefined"`.

**Fix:** Add guard before the ban check in the approval bypass:
```typescript
if (!authOk && resolvedAuth.mode === "approval" && device && devicePublicKey) {
  if (clientIp && banManager.isBanned(clientIp)) {
    close(1008, "Policy violation");
    return;
  }
  // ... password check also needs clientIp guard for recordFailure:
  if (configuredPassword) {
    if (!safeEqual(provided, approval!.password!)) {
      if (clientIp) banManager.recordFailure(clientIp);
      rejectUnauthorized();
      return;
    }
  }
  // ...
}
```

---

## Fix 5 (Module 1): Types comment — `src/agents/dormancy/types.ts`

### F5: Em dash → ASCII hyphen
Line 5 comment has em dash (`—`). Replace with plain ASCII hyphen (`-`).

---

## Fix 6 (Module 4): Strict schema — `src/config/zod-schema.ts`

### F6: Add `.strict()` to approval object
The approval inner object should be `.strict()` to match surrounding config objects and catch typos.

---

## Fix 7 (Module 11): Tool hardening — `src/agents/tools/gateway-security-tool.ts`

### F7a: IP validation in unban
Add `net.isIP()` check before calling RPC:
```typescript
import { isIP } from "node:net";
// In unban handler:
if (!isIP(ip)) return { error: "invalid IP address" };
```

### F7b: Password minimum length in reset_password
Add minimum length check (e.g., 8 chars) before writing config.

---

## File Summary

| File | Fix | Priority |
|------|-----|----------|
| `src/gateway/pair-ban.ts` | F1a, F1b | Must-fix |
| `src/gateway/pair-http.ts` | F2a, F2b | Must-fix |
| `src/gateway/server-runtime-state.ts` | F3 | Must-fix |
| `src/gateway/server-close.ts` | F3 | Must-fix |
| `src/gateway/server/ws-connection/message-handler.ts` | F4 | Must-fix |
| `src/agents/dormancy/types.ts` | F5 | Nice-to-have |
| `src/config/zod-schema.ts` | F6 | Nice-to-have |
| `src/agents/tools/gateway-security-tool.ts` | F7a, F7b | Nice-to-have |
