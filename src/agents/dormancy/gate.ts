import { logVerbose } from "../../globals.js";
import { isAgentDormant, getAgentActivatedAt } from "./dormancy.js";

export type DormancyGateParams = {
  agentId: string;
  messageTimestamp?: number;
};

export type DormancyGateResult = {
  shouldProcess: boolean;
  reason?: string;
};

/**
 * Apply dormancy gate logic to determine if a message should be processed.
 *
 * Returns shouldProcess=false if:
 * 1. Agent is dormant, OR
 * 2. Message timestamp is before the activation cursor
 */
export function applyDormancyGate(params: DormancyGateParams): DormancyGateResult {
  const { agentId, messageTimestamp } = params;

  // Check 1: Is agent dormant?
  if (isAgentDormant(agentId)) {
    logVerbose(`[dormancy] Skipping message for dormant agent: ${agentId}`);
    return { shouldProcess: false, reason: "dormant" };
  }

  // Check 2: Is message before activation cursor?
  const activatedAt = getAgentActivatedAt(agentId);
  if (activatedAt !== null && messageTimestamp !== undefined && messageTimestamp < activatedAt) {
    logVerbose(
      `[dormancy] Skipping message before cursor for ${agentId}: msg=${messageTimestamp}, cursor=${activatedAt}`,
    );
    return { shouldProcess: false, reason: "before_cursor" };
  }

  return { shouldProcess: true };
}
