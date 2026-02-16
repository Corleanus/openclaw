import path from "node:path";
import { STATE_DIR } from "../../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../infra/json-file.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { DormancyState } from "./types.js";

function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const ms = Date.parse(value);
  return !Number.isNaN(ms);
}

/**
 * Resolve the dormancy state file path for an agent.
 */
function resolveDormancyPath(agentId: string): string {
  const normalized = normalizeAgentId(agentId);
  return path.join(STATE_DIR, "agents", normalized, "dormancy.json");
}

/**
 * Load dormancy state from disk for a given agent.
 * Returns default state if file doesn't exist.
 */
export function loadDormancyState(agentId: string): DormancyState {
  const pathname = resolveDormancyPath(agentId);
  const raw = loadJsonFile(pathname);

  if (!raw || typeof raw !== "object") {
    return {
      version: 1,
      dormant: false,
      updatedAt: new Date().toISOString(),
      activatedAt: null,
      changedBy: null,
    };
  }

  const state = raw as Partial<DormancyState>;
  if (state.version !== 1) {
    return {
      version: 1,
      dormant: false,
      updatedAt: new Date().toISOString(),
      activatedAt: null,
      changedBy: null,
    };
  }

  return {
    version: 1,
    dormant: state.dormant === true,  // D3: strict boolean check
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : new Date().toISOString(),
    activatedAt: isValidIsoDate(state.activatedAt) ? state.activatedAt : null,  // D2: validate cursor
    changedBy: typeof state.changedBy === "string" ? state.changedBy : null,
  };
}

/**
 * Save dormancy state to disk for a given agent.
 */
export function saveDormancyState(agentId: string, state: DormancyState): void {
  const pathname = resolveDormancyPath(agentId);
  saveJsonFile(pathname, state);
}
