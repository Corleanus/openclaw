import { createSessionManagerRuntimeRegistry } from "./session-manager-runtime-registry.js";

export type ContextManagerRuntimeValue = {
  sessionKey: string;
  contextWindowTokens: number;
  stateDir: string;
  lastToolCall?: { name: string; paramsSummary: string };
  feedbackCounters?: {
    checkpointInjected: boolean;
    referencesDetected: number;
    sectionsReferenced: string[];
  };
};

const registry = createSessionManagerRuntimeRegistry<ContextManagerRuntimeValue>();

export const setContextManagerRuntime = registry.set;

export const getContextManagerRuntime = registry.get;
