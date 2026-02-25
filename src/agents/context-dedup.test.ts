import { describe, expect, it } from "vitest";
import { isSemanticDuplicate, normalize, extractKeywords } from "./context-dedup.js";

describe("isSemanticDuplicate", () => {
  // Tier 1: Normalized exact match
  it("matches after stripping bullets and markdown", () => {
    expect(isSemanticDuplicate("- **Use atomicWriteFile**", "use atomicwritefile")).toBe(true);
  });

  it("matches after collapsing whitespace", () => {
    expect(isSemanticDuplicate("merge  strategy   set-diff", "merge strategy set-diff")).toBe(true);
  });

  // Tier 2: Keyword overlap (Jaccard >= 0.5)
  it("matches rephrased statements with shared keywords", () => {
    expect(isSemanticDuplicate("Send Grigorije a plan", "send plan to Grigorije")).toBe(true);
  });

  it("rejects genuinely different items with low keyword overlap", () => {
    expect(isSemanticDuplicate("Use atomicWriteFile for checkpoint", "Deploy gateway on port 5555")).toBe(false);
  });

  // Cardinality guard
  it("skips Jaccard when fewer than 3 keywords in union", () => {
    expect(isSemanticDuplicate("fix bug", "fix typo")).toBe(false);
  });

  // Tier 3: Substring containment
  it("matches when short string is substring of long", () => {
    expect(isSemanticDuplicate("checkpoint re-write", "use atomicWriteFile for checkpoint re-write to bypass dedup")).toBe(true);
  });

  it("rejects substring match when short string is < 10 chars", () => {
    expect(isSemanticDuplicate("fix", "fix the bug in parser")).toBe(false);
  });

  // Serbian stop words
  it("filters Serbian stop words in keyword extraction", () => {
    expect(isSemanticDuplicate("treba da se napravi checkpoint", "napravi checkpoint")).toBe(true);
  });

  // False negative preservation
  it("does not merge genuinely different items sharing vocabulary", () => {
    // "atomic write" shares no meaningful keywords with "deploy gateway port"
    expect(isSemanticDuplicate(
      "Implement atomic write for checkpoint persistence",
      "Deploy gateway on different port for staging",
    )).toBe(false);
  });
});

describe("extractKeywords", () => {
  it("removes stop words and short words", () => {
    const kw = extractKeywords("I need to fix the bug in parser");
    expect(kw.has("fix")).toBe(true);
    expect(kw.has("bug")).toBe(true);
    expect(kw.has("parser")).toBe(true);
    expect(kw.has("the")).toBe(false);
    expect(kw.has("i")).toBe(false);
    expect(kw.has("to")).toBe(false);
  });
});

describe("normalize", () => {
  it("strips bullets and markdown", () => {
    expect(normalize("- **bold text** here")).toBe("bold text here");
  });

  it("strips numbered list prefix", () => {
    expect(normalize("1. First item")).toBe("first item");
  });
});
