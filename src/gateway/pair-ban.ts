import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import path from "node:path";

export type BanRecord = {
  ip: string;
  failureCount: number;
  bannedAt: string | null; // ISO timestamp, null if not yet banned
  lastFailureAt: string; // ISO timestamp
};

type BanStore = {
  version: 1;
  records: Record<string, BanRecord>; // keyed by IP
};

const BAN_FILE = path.join(STATE_DIR, "gateway", "pair-bans.json");

export type PairBanManager = {
  isBanned(ip: string): boolean;
  recordFailure(ip: string): { banned: boolean; failureCount: number };
  unban(ip: string): boolean;
  listBanned(): BanRecord[];
};

export function createPairBanManager(opts?: {
  maxFailures?: number;
}): PairBanManager {
  const maxFailures = opts?.maxFailures ?? 3;

  // Load from disk on creation
  let store = loadStore();

  function loadStore(): BanStore {
    const raw = loadJsonFile(BAN_FILE);
    if (raw && typeof raw === "object" && (raw as any).version === 1 && typeof (raw as any).records === "object" && (raw as any).records !== null) {
      return raw as BanStore;
    }
    return { version: 1, records: {} };
  }

  function persist(): void {
    saveJsonFile(BAN_FILE, store);
  }

  function isBanned(ip: string): boolean {
    return store.records[ip]?.bannedAt !== null && store.records[ip]?.bannedAt !== undefined;
  }

  function recordFailure(ip: string): { banned: boolean; failureCount: number } {
    const now = new Date().toISOString();
    const existing = store.records[ip];
    if (existing?.bannedAt) {
      return { banned: true, failureCount: existing.failureCount };
    }
    const failureCount = (existing?.failureCount ?? 0) + 1;
    const banned = failureCount >= maxFailures;

    store.records[ip] = {
      ip,
      failureCount,
      bannedAt: banned ? now : null,
      lastFailureAt: now,
    };
    persist();

    return { banned, failureCount };
  }

  function unban(ip: string): boolean {
    if (!store.records[ip]) return false;
    delete store.records[ip];
    persist();
    return true;
  }

  function listBanned(): BanRecord[] {
    return Object.values(store.records).filter((r) => r.bannedAt !== null);
  }

  return { isBanned, recordFailure, unban, listBanned };
}
