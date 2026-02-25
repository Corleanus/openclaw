import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

const log = createSubsystemLogger("context-learnings");

// ---------- Types ----------

export interface CrossSessionLearning {
  id: string;
  text: string;
  source_session: string;
  created_at: string;
  last_promoted_at: string;
  promotion_count: number;
  last_checkpoint_id: string;
}

export interface CrossSessionLearningsStore {
  version: 1;
  max_entries: 50;
  learnings: CrossSessionLearning[];
}

// ---------- Path helpers ----------

function learningsDir(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, "context", "learnings", resolveAgentIdFromSessionKey(sessionKey));
}

// ---------- Atomic write (matches context-checkpoint.ts pattern) ----------

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);

  await fs.promises.writeFile(tmp, content, { encoding: "utf-8" });

  try {
    await fs.promises.rename(tmp, filePath);
  } catch (err) {
    const code = (err as { code?: string }).code;
    // Windows doesn't reliably support atomic replace via rename when dest exists.
    if (code === "EPERM" || code === "EEXIST") {
      await fs.promises.copyFile(tmp, filePath);
      await fs.promises.chmod(filePath, 0o600).catch(() => {
        // best-effort
      });
      await fs.promises.unlink(tmp).catch(() => {
        // best-effort
      });
      return;
    }
    await fs.promises.unlink(tmp).catch(() => {
      // best-effort
    });
    throw err;
  }
}

// ---------- Read / Write ----------

const EMPTY_STORE: CrossSessionLearningsStore = { version: 1, max_entries: 50, learnings: [] };

export async function readCrossSessionLearnings(
  stateDir: string,
  sessionKey: string,
): Promise<CrossSessionLearningsStore> {
  const filePath = path.join(learningsDir(stateDir, sessionKey), "learnings.json");
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as CrossSessionLearningsStore;
  } catch {
    return { ...EMPTY_STORE, learnings: [] };
  }
}

export async function writeCrossSessionLearnings(
  stateDir: string,
  sessionKey: string,
  store: CrossSessionLearningsStore,
): Promise<void> {
  const dir = learningsDir(stateDir, sessionKey);
  await fs.promises.mkdir(dir, { recursive: true });
  await atomicWriteFile(path.join(dir, "learnings.json"), JSON.stringify(store, null, 2));
}

// ---------- Fingerprinting ----------

function fingerprint(text: string): string {
  return text.toLowerCase().trim().replace(/^[-*•]\s*/, "").replace(/\s+/g, " ");
}

// ---------- Promote ----------

export async function promoteLearningsToCrossSession(
  stateDir: string,
  sessionKey: string,
  learnings: Array<{ text: string; when: string }>,
  checkpointId: string,
): Promise<void> {
  const store = await readCrossSessionLearnings(stateDir, sessionKey);
  const now = new Date().toISOString();

  for (const learning of learnings) {
    const fp = fingerprint(learning.text);
    const existing = store.learnings.find((l) => fingerprint(l.text) === fp);

    if (existing) {
      if (existing.last_checkpoint_id === checkpointId) {
        continue; // idempotency — already promoted for this checkpoint
      }
      existing.promotion_count++;
      existing.last_promoted_at = now;
      existing.last_checkpoint_id = checkpointId;
    } else {
      store.learnings.push({
        id: crypto.randomUUID(),
        text: learning.text,
        source_session: sessionKey,
        created_at: learning.when || now,
        last_promoted_at: now,
        promotion_count: 1,
        last_checkpoint_id: checkpointId,
      });
    }
  }

  // Evict oldest if over capacity
  if (store.learnings.length > 50) {
    store.learnings.sort(
      (a, b) => new Date(a.last_promoted_at).getTime() - new Date(b.last_promoted_at).getTime(),
    );
    store.learnings = store.learnings.slice(-50);
  }

  await writeCrossSessionLearnings(stateDir, sessionKey, store);
}
