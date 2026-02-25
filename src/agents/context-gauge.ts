export interface GaugeResult {
  utilization: number;
  inputTokens: number;
  contextWindow: number;
  shouldCheckpoint: boolean;
  shouldInject: boolean;
}

export function calculateUtilization(
  usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
  contextWindowTokens: number,
): GaugeResult {
  if (usage && usage.percent != null) {
    const utilization = usage.percent / 100;
    const inputTokens = usage.tokens ?? Math.round(utilization * usage.contextWindow);
    return {
      utilization,
      inputTokens,
      contextWindow: usage.contextWindow,
      shouldCheckpoint: utilization >= 0.8,
      shouldInject: utilization >= 0.7,
    };
  }

  if (usage && usage.tokens != null && usage.contextWindow > 0) {
    const utilization = usage.tokens / usage.contextWindow;
    return {
      utilization,
      inputTokens: usage.tokens,
      contextWindow: usage.contextWindow,
      shouldCheckpoint: utilization >= 0.8,
      shouldInject: utilization >= 0.7,
    };
  }

  return {
    utilization: 0,
    inputTokens: 0,
    contextWindow: contextWindowTokens,
    shouldCheckpoint: false,
    shouldInject: false,
  };
}

export function formatGaugeLine(result: GaugeResult, checkpointSaved = false): string {
  const pct = Math.round(result.utilization * 100);
  const inputK = Math.round(result.inputTokens / 1000);
  const ctxK = Math.round(result.contextWindow / 1000);
  const suffix = checkpointSaved ? " | Checkpoint saved" : "";
  return `[Context: ${pct}% | ${inputK}k/${ctxK}k tokens${suffix}]`;
}
