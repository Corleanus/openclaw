import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { stringify, parse } from "yaml";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("context-checkpoint");

// ---------- Types ----------

export type CheckpointTrigger = "auto-80pct" | "compaction";

export interface CheckpointTokenUsage {
  input_tokens: number;
  context_window: number;
  utilization: number; // 0-1 ratio
}

export interface CheckpointMeta {
  checkpoint_id: string;
  session_key: string;
  session_file: string | null;
  created_at: string; // ISO-8601
  trigger: CheckpointTrigger;
  compaction_count: number;
  token_usage: CheckpointTokenUsage;
  previous_checkpoint: string | null;
  channel: string | null;
  agent_id: string | null;
}

export interface CheckpointWorking {
  topic: string;
  status: "in_progress" | "idle" | "waiting_for_user";
  interrupted: boolean;
  last_tool_call: { name: string; params_summary: string } | null;
  next_action: string;
}

export interface CheckpointDecision {
  id: string;
  what: string;
  when: string; // ISO-8601
}

export interface CheckpointResources {
  files_read: string[];
  files_modified: string[];
  tools_used: string[];
}

export interface CheckpointThread {
  summary: string;
  key_exchanges: Array<{ role: "user" | "agent"; gist: string }>;
}

export interface Checkpoint {
  schema: "openclaw/checkpoint";
  schema_version: 1;
  meta: CheckpointMeta;
  working: CheckpointWorking;
  decisions: CheckpointDecision[];
  resources: CheckpointResources;
  thread: CheckpointThread;
  open_items: string[];
  learnings: string[];
}

// ---------- Latest pointer ----------

interface LatestPointer {
  checkpoint_id: string;
  path: string;
  input_tokens?: number;
}

// ---------- Path helpers ----------

export function sanitizeSessionKeyForPath(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function checkpointDir(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, "context", "checkpoints", sanitizeSessionKeyForPath(sessionKey));
}

export function latestPointerPath(stateDir: string, sessionKey: string): string {
  return path.join(checkpointDir(stateDir, sessionKey), "_latest.json");
}

// ---------- Internal helpers ----------

function nextCheckpointId(currentId: string | null): string {
  if (!currentId) {
    return "cp_001";
  }
  const match = currentId.match(/^cp_(\d+)$/);
  if (!match) {
    return "cp_001";
  }
  const num = Number.parseInt(match[1], 10) + 1;
  return `cp_${String(num).padStart(3, "0")}`;
}

async function readLatestPointer(dir: string): Promise<LatestPointer | null> {
  const pointerPath = path.join(dir, "_latest.json");
  try {
    const raw = await fs.promises.readFile(pointerPath, "utf-8");
    return JSON.parse(raw) as LatestPointer;
  } catch {
    return null;
  }
}

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

// ---------- Core operations ----------

export async function writeCheckpoint(
  stateDir: string,
  sessionKey: string,
  checkpoint: Checkpoint,
): Promise<{ written: boolean; path: string }> {
  const dir = checkpointDir(stateDir, sessionKey);
  await fs.promises.mkdir(dir, { recursive: true });

  const latest = await readLatestPointer(dir);

  // Dedup: skip write if input_tokens delta < 5% from last checkpoint
  if (latest?.input_tokens != null && checkpoint.meta.token_usage.input_tokens > 0) {
    const delta = Math.abs(
      checkpoint.meta.token_usage.input_tokens - latest.input_tokens,
    );
    const ratio = delta / latest.input_tokens;
    if (ratio < 0.05) {
      log.debug(
        `Skipping checkpoint write: token delta ${(ratio * 100).toFixed(1)}% < 5% threshold`,
      );
      const existingPath = path.join(dir, latest.path);
      return { written: false, path: existingPath };
    }
  }

  const currentId = latest?.checkpoint_id ?? null;
  const newId = nextCheckpointId(currentId);

  checkpoint.meta.checkpoint_id = newId;
  checkpoint.meta.previous_checkpoint = currentId;

  const filename = `${newId}.yaml`;
  const filePath = path.join(dir, filename);

  const yamlContent = stringify(checkpoint);
  await atomicWriteFile(filePath, yamlContent);

  // Update _latest.json pointer
  const pointer: LatestPointer = {
    checkpoint_id: newId,
    path: filename,
    input_tokens: checkpoint.meta.token_usage.input_tokens,
  };
  await atomicWriteFile(
    path.join(dir, "_latest.json"),
    JSON.stringify(pointer, null, 2),
  );

  log.info(`Checkpoint ${newId} written for session ${sessionKey}`);
  return { written: true, path: filePath };
}

export async function readLatestCheckpoint(
  stateDir: string,
  sessionKey: string,
): Promise<Checkpoint | null> {
  const dir = checkpointDir(stateDir, sessionKey);
  const latest = await readLatestPointer(dir);
  if (!latest) {
    return null;
  }

  // Validate checkpoint filename pattern
  const filename = latest.path;
  if (!/^cp_\d+\.yaml$/.test(filename)) {
    log.warn(`Invalid checkpoint filename in _latest.json: ${filename}`);
    return null;
  }
  // Resolve and verify path stays under checkpoint dir
  const resolvedPath = path.resolve(dir, filename);
  if (!resolvedPath.startsWith(path.resolve(dir))) {
    log.warn(`Checkpoint path escapes directory: ${filename}`);
    return null;
  }

  try {
    const raw = await fs.promises.readFile(resolvedPath, "utf-8");
    return parse(raw) as Checkpoint;
  } catch {
    log.warn(`Failed to read checkpoint file: ${resolvedPath}`);
    return null;
  }
}

export async function pruneOldCheckpoints(
  stateDir: string,
  sessionKey: string,
  keep = 5,
): Promise<void> {
  const dir = checkpointDir(stateDir, sessionKey);

  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return; // dir doesn't exist, nothing to prune
  }

  const cpFiles = entries.filter((f) => /^cp_\d+\.yaml$/.test(f)).sort();

  if (cpFiles.length <= keep) {
    return;
  }

  const toDelete = cpFiles.slice(0, cpFiles.length - keep);
  for (const file of toDelete) {
    try {
      await fs.promises.unlink(path.join(dir, file));
      log.debug(`Pruned old checkpoint: ${file}`);
    } catch (err) {
      log.warn(`Failed to prune checkpoint ${file}: ${(err as Error).message}`);
    }
  }
}
