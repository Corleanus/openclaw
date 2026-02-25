import { describe, expect, it } from "vitest";
import { __testing } from "./pi-extensions/context-manager.js";

const { extractDecisionFromResponse, isRealUserMessage } = __testing;

// ---------- extractDecisionFromResponse ----------

describe("extractDecisionFromResponse", () => {
  it("extracts tier 1 explicit marker over tier 3 bold", () => {
    const text = "Some intro text\n**Bold heading**\nDecision: use atomicWriteFile for writes";
    expect(extractDecisionFromResponse(text)).toContain("use atomicWriteFile");
  });

  it("returns null for conversational filler", () => {
    expect(extractDecisionFromResponse("You're right, I overcomplicated it. Let me simplify.")).toBeNull();
  });

  it("returns null for code-fence-only response", () => {
    const text = "```typescript\nconst x = 1;\nconst y = 2;\n```";
    expect(extractDecisionFromResponse(text)).toBeNull();
  });

  it("extracts action verb bullet at tier 4", () => {
    const text = "Here's what we discussed:\n- implement retry logic for failed requests\n- maybe look at other options";
    const result = extractDecisionFromResponse(text);
    expect(result).toContain("implement retry logic");
  });

  it("rejects questions", () => {
    expect(extractDecisionFromResponse("Should we use Redis for caching?")).toBeNull();
  });

  it("truncates to 200 chars", () => {
    const longDecision = "Decision: " + "a".repeat(300);
    const result = extractDecisionFromResponse(longDecision);
    expect(result!.length).toBeLessThanOrEqual(200);
  });
});

// ---------- isRealUserMessage ----------

describe("isRealUserMessage", () => {
  it("passes real user message", () => {
    const msg = { role: "user", content: "How do I fix this bug?" };
    expect(isRealUserMessage(msg as any)).toBe(true);
  });

  it("rejects checkpoint-data injection", () => {
    const msg = { role: "user", content: '<checkpoint-data source="context-manager">...' };
    expect(isRealUserMessage(msg as any)).toBe(false);
  });

  it("rejects compaction summary", () => {
    const msg = { role: "user", content: "This summary covers the conversation so far..." };
    expect(isRealUserMessage(msg as any)).toBe(false);
  });

  it("rejects token gauge", () => {
    const msg = { role: "user", content: "## Token Gauge\n- Utilization: 45%" };
    expect(isRealUserMessage(msg as any)).toBe(false);
  });

  it("rejects assistant messages", () => {
    const msg = { role: "assistant", content: "Here's the answer" };
    expect(isRealUserMessage(msg as any)).toBe(false);
  });
});
