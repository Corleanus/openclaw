import type { DormancyState } from "./types.js";
import { loadDormancyState, saveDormancyState } from "./store.js";
import { normalizeAgentId } from "../../routing/session-key.js";

/**
 * In-memory cache for dormancy states.
 * Lazily loaded from disk on first access per agent.
 */
const dormancyCache = new Map<string, DormancyState>();

/**
 * Get dormancy state from cache, loading from disk if not yet cached.
 */
function getCachedState(agentId: string): DormancyState {
  const key = normalizeAgentId(agentId);
  let state = dormancyCache.get(key);
  if (!state) {
    state = loadDormancyState(key);
    dormancyCache.set(key, state);
  }
  return state;
}

/**
 * Update state in both cache and disk.
 */
function updateState(agentId: string, state: DormancyState): DormancyState {
  const key = normalizeAgentId(agentId);
  dormancyCache.set(key, state);
  saveDormancyState(key, state);
  return state;
}

/**
 * Check if an agent is dormant (hot path).
 */
export function isAgentDormant(agentId: string): boolean {
  const state = getCachedState(agentId);
  return state.dormant;
}

/**
 * Get the activation cursor timestamp in epoch milliseconds.
 * Returns null if no cursor is set.
 */
export function getAgentActivatedAt(agentId: string): number | null {
  const state = getCachedState(agentId);
  if (!state.activatedAt) {
    return null;
  }
  return new Date(state.activatedAt).getTime();
}

/**
 * Activate an agent (set dormant=false, update activatedAt cursor).
 */
export function activateAgent(agentId: string, changedBy: string): DormancyState {
  const current = getCachedState(agentId);
  if (!current.dormant) {
    return current; // already active, don't reset cursor
  }
  const now = new Date().toISOString();
  const state: DormancyState = {
    version: 1,
    dormant: false,
    updatedAt: now,
    activatedAt: now,
    changedBy,
  };
  return updateState(agentId, state);
}

/**
 * Deactivate an agent (set dormant=true, clear activatedAt cursor).
 */
export function deactivateAgent(agentId: string, changedBy: string): DormancyState {
  const state: DormancyState = {
    version: 1,
    dormant: true,
    updatedAt: new Date().toISOString(),
    activatedAt: null,
    changedBy,
  };
  return updateState(agentId, state);
}

/**
 * Get the full dormancy state for an agent.
 */
export function getDormancyState(agentId: string): DormancyState {
  return getCachedState(agentId);
}

/**
 * Invalidate the cache for an agent (useful after external writes).
 */
export function invalidateDormancyCache(agentId: string): void {
  dormancyCache.delete(normalizeAgentId(agentId));
}
