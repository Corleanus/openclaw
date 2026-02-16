export type PairRateLimiter = {
  /** Full check for /pair/request -- pendingCount + cooldown + window. Returns retryAfterSeconds for 429 header. */
  checkRequest(ip: string): { ok: boolean; retryAfterSeconds: number };
  /** Lightweight check for /pair/status -- window only, no cooldown. Returns retryAfterSeconds for 429 header. */
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
  statusRequestsInWindow: number[]; // separate window for status
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
    // 3x the normal window limit -- supports 3s polling (~20/min fits within 30 limit)
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
