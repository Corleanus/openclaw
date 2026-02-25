import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendDecisionToState,
  appendLearningToState,
  appendOpenItemToState,
  initStateDir,
  readStateFiles,
  resetStateFiles,
  scoreFileAccess,
} from "./context-state.js";
import type { FileAccess } from "./context-state.js";

let tmpDir: string;
const SESSION_KEY = "test-session";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "context-state-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------- scoreFileAccess ----------

describe("scoreFileAccess", () => {
  const now = new Date("2025-01-01T12:00:00Z");

  it("scores a recently accessed file higher than an old file", () => {
    const recent: FileAccess = {
      path: "a.ts",
      access_count: 1,
      last_accessed: "2025-01-01T11:50:00Z", // 10 min ago
      kind: "read",
    };
    const old: FileAccess = {
      path: "b.ts",
      access_count: 1,
      last_accessed: "2025-01-01T00:00:00Z", // 12 hours ago
      kind: "read",
    };

    expect(scoreFileAccess(recent, now)).toBeGreaterThan(scoreFileAccess(old, now));
  });

  it("gives a modified file a 1.5x bonus over a read file", () => {
    const base: Omit<FileAccess, "kind"> = {
      path: "x.ts",
      access_count: 1,
      last_accessed: now.toISOString(),
    };
    const readScore = scoreFileAccess({ ...base, kind: "read" }, now);
    const modifiedScore = scoreFileAccess({ ...base, kind: "modified" }, now);

    expect(modifiedScore / readScore).toBeCloseTo(1.5, 5);
  });

  it("scores higher access_count higher", () => {
    const low: FileAccess = {
      path: "a.ts",
      access_count: 1,
      last_accessed: now.toISOString(),
      kind: "read",
    };
    const high: FileAccess = {
      path: "a.ts",
      access_count: 5,
      last_accessed: now.toISOString(),
      kind: "read",
    };

    expect(scoreFileAccess(high, now)).toBeGreaterThan(scoreFileAccess(low, now));
  });

  it("returns a non-negative score", () => {
    const file: FileAccess = {
      path: "old.ts",
      access_count: 1,
      last_accessed: "2020-01-01T00:00:00Z",
      kind: "read",
    };

    expect(scoreFileAccess(file, now)).toBeGreaterThanOrEqual(0);
  });
});

// ---------- appendDecisionToState ----------

describe("appendDecisionToState", () => {
  beforeEach(async () => {
    await initStateDir(tmpDir, SESSION_KEY);
  });

  it("writes a decision with auto-generated id", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use postgres",
      when: "2025-01-01T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(1);
    expect(state.decisions[0]).toMatchObject({
      id: "d1",
      what: "Use postgres",
      when: "2025-01-01T00:00:00Z",
    });
  });

  it("deduplicates by fingerprint — same text different case", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use Postgres",
      when: "2025-01-01T00:00:00Z",
    });
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "use postgres",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(1);
  });

  it("deduplicates by fingerprint — leading bullet prefix stripped", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "- Use redis",
      when: "2025-01-01T00:00:00Z",
    });
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use redis",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(1);
  });

  it("does not deduplicate different text", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use postgres",
      when: "2025-01-01T00:00:00Z",
    });
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use redis",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(2);
  });

  it("respects MAX_DECISIONS (50) cap", async () => {
    for (let i = 0; i < 55; i++) {
      await appendDecisionToState(tmpDir, SESSION_KEY, {
        what: `Decision ${i}`,
        when: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      });
    }

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(50);
  });
});

// ---------- appendOpenItemToState ----------

describe("appendOpenItemToState", () => {
  beforeEach(async () => {
    await initStateDir(tmpDir, SESSION_KEY);
  });

  it("writes an item to open_items.json", async () => {
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.open_items).toEqual(["Fix the bug"]);
  });

  it("deduplicates by exact string match", async () => {
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.open_items).toHaveLength(1);
  });

  it("does not deduplicate different strings", async () => {
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");
    await appendOpenItemToState(tmpDir, SESSION_KEY, "fix the bug"); // different case

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.open_items).toHaveLength(2);
  });

  it("respects MAX_OPEN_ITEMS (50) cap", async () => {
    for (let i = 0; i < 55; i++) {
      await appendOpenItemToState(tmpDir, SESSION_KEY, `Item ${i}`);
    }

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.open_items).toHaveLength(50);
  });
});

// ---------- appendLearningToState ----------

describe("appendLearningToState", () => {
  beforeEach(async () => {
    await initStateDir(tmpDir, SESSION_KEY);
  });

  it("writes a learning to learnings.json", async () => {
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Vitest is fast",
      when: "2025-01-01T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.learnings).toHaveLength(1);
    expect(state.learnings[0]).toMatchObject({
      text: "Vitest is fast",
      when: "2025-01-01T00:00:00Z",
    });
  });

  it("deduplicates by fingerprint — same text different case", async () => {
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Vitest Is Fast",
      when: "2025-01-01T00:00:00Z",
    });
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "vitest is fast",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.learnings).toHaveLength(1);
  });

  it("deduplicates by fingerprint — leading * prefix stripped", async () => {
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "* Use vitest",
      when: "2025-01-01T00:00:00Z",
    });
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Use vitest",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.learnings).toHaveLength(1);
  });

  it("does not deduplicate different text", async () => {
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Vitest is fast",
      when: "2025-01-01T00:00:00Z",
    });
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "TypeScript is typed",
      when: "2025-01-02T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.learnings).toHaveLength(2);
  });

  it("respects MAX_LEARNINGS (10) cap", async () => {
    for (let i = 0; i < 15; i++) {
      await appendLearningToState(tmpDir, SESSION_KEY, {
        text: `Learning ${i}`,
        when: `2025-01-01T00:${String(i).padStart(2, "0")}:00Z`,
      });
    }

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.learnings).toHaveLength(10);
  });
});

// ---------- readStateFiles + resetStateFiles (integration) ----------

describe("readStateFiles + resetStateFiles", () => {
  beforeEach(async () => {
    await initStateDir(tmpDir, SESSION_KEY);
  });

  it("returns all appended data via readStateFiles", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use postgres",
      when: "2025-01-01T00:00:00Z",
    });
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Vitest is fast",
      when: "2025-01-01T00:00:00Z",
    });

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toHaveLength(1);
    expect(state.open_items).toEqual(["Fix the bug"]);
    expect(state.learnings).toHaveLength(1);
  });

  it("returns empty arrays after resetStateFiles", async () => {
    await appendDecisionToState(tmpDir, SESSION_KEY, {
      what: "Use postgres",
      when: "2025-01-01T00:00:00Z",
    });
    await appendOpenItemToState(tmpDir, SESSION_KEY, "Fix the bug");
    await appendLearningToState(tmpDir, SESSION_KEY, {
      text: "Vitest is fast",
      when: "2025-01-01T00:00:00Z",
    });

    await resetStateFiles(tmpDir, SESSION_KEY);

    const state = await readStateFiles(tmpDir, SESSION_KEY);
    expect(state.decisions).toEqual([]);
    expect(state.open_items).toEqual([]);
    expect(state.learnings).toEqual([]);
    expect(state.thread).toEqual([]);
    expect(state.resources.files).toEqual([]);
    expect(state.resources.tools_used).toEqual([]);
  });
});
