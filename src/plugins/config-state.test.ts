import { describe, expect, it } from "vitest";
import { normalizePluginsConfig, resolveMemorySlotDecision } from "./config-state.js";

describe("normalizePluginsConfig", () => {
  it("uses default memory slot when not specified", () => {
    const result = normalizePluginsConfig({});
    expect(result.slots.memory).toBe("memory-core");
  });

  it("respects explicit memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "custom-memory" },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("disables memory slot when set to 'none' (case insensitive)", () => {
    expect(
      normalizePluginsConfig({
        slots: { memory: "none" },
      }).slots.memory,
    ).toBeNull();
    expect(
      normalizePluginsConfig({
        slots: { memory: "None" },
      }).slots.memory,
    ).toBeNull();
  });

  it("trims whitespace from memory slot value", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "  custom-memory  " },
    });
    expect(result.slots.memory).toBe("custom-memory");
  });

  it("uses default when memory slot is empty string", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "" },
    });
    expect(result.slots.memory).toBe("memory-core");
  });

  it("uses default when memory slot is whitespace only", () => {
    const result = normalizePluginsConfig({
      slots: { memory: "   " },
    });
    expect(result.slots.memory).toBe("memory-core");
  });
});

describe("resolveMemorySlotDecision", () => {
  it("allows supplementary memory plugins regardless of slot", () => {
    const result = resolveMemorySlotDecision({
      id: "openclaw-mem0",
      kind: "memory",
      slot: "memory-core",
      selectedId: "memory-core",
      supplementary: true,
    });
    expect(result.enabled).toBe(true);
  });

  it("disables non-supplementary memory plugins when slot is set to another", () => {
    const result = resolveMemorySlotDecision({
      id: "other-memory",
      kind: "memory",
      slot: "memory-core",
      selectedId: "memory-core",
    });
    expect(result.enabled).toBe(false);
  });
});
