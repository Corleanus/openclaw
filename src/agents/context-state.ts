import fs from "node:fs";
import path from "node:path";
import { sanitizeSessionKeyForPath } from "./context-checkpoint.js";
import { isSemanticDuplicate } from "./context-dedup.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("context-state");

export interface FileAccess {
  path: string;
  access_count: number;
  last_accessed: string; // ISO-8601
  kind: "read" | "modified"; // highest privilege seen (modified > read)
}

export interface StateFiles {
  decisions: Array<{ id: string; what: string; when: string }>;
  thread: Array<{ role: "user" | "agent"; gist: string }>;
  resources: { files: FileAccess[]; tools_used: string[] };
  open_items: string[];
  learnings: Array<{ text: string; when: string }>;
}

export interface ThreadSnapshot {
  topic: string;
  summary: string;
  key_exchanges: Array<{ role: "user" | "agent"; gist: string }>;
  updated_at: string;
}

const MAX_DECISIONS = 50;
const MAX_THREAD = 8;
const MAX_TOOLS = 100;
const MAX_FILES_PER_CATEGORY = 100;
const MAX_OPEN_ITEMS = 50;
const MAX_LEARNINGS = 10;

function resolveStateDir(stateDir: string, sessionKey: string): string {
  return path.join(stateDir, "context", "state", sanitizeSessionKeyForPath(sessionKey));
}

function emptyResources(): StateFiles["resources"] {
  return { files: [], tools_used: [] };
}

/** Normalize legacy resources format (files_read/files_modified) to new FileAccess format. */
function normalizeResources(raw: Record<string, unknown>): StateFiles["resources"] {
  if (Array.isArray((raw as { files?: unknown }).files)) {
    return raw as StateFiles["resources"];
  }
  // Legacy format: { files_read: string[], files_modified: string[], tools_used: string[] }
  const filesRead = Array.isArray(raw.files_read) ? (raw.files_read as string[]) : [];
  const filesModified = Array.isArray(raw.files_modified) ? (raw.files_modified as string[]) : [];
  const toolsUsed = Array.isArray(raw.tools_used) ? (raw.tools_used as string[]) : [];
  const now = new Date().toISOString();
  const fileMap = new Map<string, FileAccess>();
  for (const p of filesRead) {
    fileMap.set(p, { path: p, access_count: 1, last_accessed: now, kind: "read" });
  }
  for (const p of filesModified) {
    const existing = fileMap.get(p);
    if (existing) {
      existing.kind = "modified";
    } else {
      fileMap.set(p, { path: p, access_count: 1, last_accessed: now, kind: "modified" });
    }
  }
  return { files: [...fileMap.values()], tools_used: toolsUsed };
}

/** Score a file access entry for hot/cold ranking. */
export function scoreFileAccess(file: FileAccess, now: Date = new Date()): number {
  const ageMinutes = Math.max(0, (now.getTime() - new Date(file.last_accessed).getTime()) / 60000);
  const recency = Math.exp(-0.003 * ageMinutes); // half-life ~3.8 hours
  const kindBonus = file.kind === "modified" ? 1.5 : 1.0;
  return file.access_count * recency * kindBonus;
}

function emptyState(): StateFiles {
  return {
    decisions: [],
    thread: [],
    resources: emptyResources(),
    open_items: [],
    learnings: [],
  };
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export async function initStateDir(stateDir: string, sessionKey: string): Promise<string> {
  const dir = resolveStateDir(stateDir, sessionKey);
  await fs.promises.mkdir(dir, { recursive: true });

  const files: Array<[string, unknown]> = [
    ["decisions.json", []],
    ["thread.json", []],
    ["resources.json", emptyResources()],
    ["open_items.json", []],
    ["learnings.json", []],
  ];

  for (const [name, defaultValue] of files) {
    const filePath = path.join(dir, name);
    try {
      await fs.promises.access(filePath);
    } catch {
      await writeJsonFile(filePath, defaultValue);
    }
  }

  return dir;
}

export async function appendToolToState(
  stateDir: string,
  sessionKey: string,
  toolName: string,
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const filePath = path.join(dir, "resources.json");

  try {
    const resources = await readJsonFile<StateFiles["resources"]>(filePath, emptyResources());
    if (resources.tools_used.includes(toolName)) {
      return;
    }
    if (resources.tools_used.length >= MAX_TOOLS) {
      return;
    }
    resources.tools_used.push(toolName);
    await writeJsonFile(filePath, resources);
  } catch (err) {
    log.warn("Failed to append tool to state", { error: String(err) });
  }
}

export async function appendFileToState(
  stateDir: string,
  sessionKey: string,
  filePath: string,
  kind: "read" | "modified",
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const resourcesPath = path.join(dir, "resources.json");

  try {
    const raw = await readJsonFile<Record<string, unknown>>(resourcesPath, {});
    const resources = normalizeResources(raw);
    const now = new Date().toISOString();
    const existing = resources.files.find((f) => f.path === filePath);
    if (existing) {
      existing.access_count++;
      existing.last_accessed = now;
      if (kind === "modified" && existing.kind === "read") {
        existing.kind = "modified";
      }
    } else {
      if (resources.files.length >= MAX_FILES_PER_CATEGORY) {
        // Evict lowest-scored entry
        const nowDate = new Date();
        resources.files.sort((a, b) => scoreFileAccess(b, nowDate) - scoreFileAccess(a, nowDate));
        resources.files.pop();
      }
      resources.files.push({ path: filePath, access_count: 1, last_accessed: now, kind });
    }
    await writeJsonFile(resourcesPath, resources);
  } catch (err) {
    log.warn("Failed to append file to state", { error: String(err) });
  }
}

export async function appendDecisionToState(
  stateDir: string,
  sessionKey: string,
  decision: { what: string; when: string },
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const filePath = path.join(dir, "decisions.json");

  try {
    const decisions = await readJsonFile<StateFiles["decisions"]>(filePath, []);
    if (decisions.length >= MAX_DECISIONS) {
      return;
    }
    if (decisions.some((d) => isSemanticDuplicate(d.what, decision.what))) {
      return;
    }
    const id = `d${decisions.length + 1}`;
    decisions.push({ id, ...decision });
    await writeJsonFile(filePath, decisions);
  } catch (err) {
    log.warn("Failed to append decision to state", { error: String(err) });
  }
}

export async function appendThreadToState(
  stateDir: string,
  sessionKey: string,
  entry: { role: "user" | "agent"; gist: string },
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const filePath = path.join(dir, "thread.json");

  try {
    let thread = await readJsonFile<StateFiles["thread"]>(filePath, []);
    thread.push(entry);
    if (thread.length > MAX_THREAD) {
      thread = thread.slice(-MAX_THREAD);
    }
    await writeJsonFile(filePath, thread);
  } catch (err) {
    log.warn("Failed to append thread to state", { error: String(err) });
  }
}

export async function appendOpenItemToState(
  stateDir: string,
  sessionKey: string,
  item: string,
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const filePath = path.join(dir, "open_items.json");

  try {
    const items = await readJsonFile<StateFiles["open_items"]>(filePath, []);
    if (items.some(existing => isSemanticDuplicate(existing, item))) {
      return;
    }
    if (items.length >= MAX_OPEN_ITEMS) {
      return;
    }
    items.push(item);
    await writeJsonFile(filePath, items);
  } catch (err) {
    log.warn("Failed to append open item to state", { error: String(err) });
  }
}

function normalizeLearningFingerprint(text: string): string {
  return text.toLowerCase().replace(/^[\s\-*•.]+/, "").replace(/\s+/g, " ").trim();
}

export async function appendLearningToState(
  stateDir: string,
  sessionKey: string,
  learning: { text: string; when: string },
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  const filePath = path.join(dir, "learnings.json");

  try {
    const learnings = await readJsonFile<StateFiles["learnings"]>(filePath, []);
    if (learnings.length >= MAX_LEARNINGS) {
      return;
    }
    const fingerprint = normalizeLearningFingerprint(learning.text);
    if (learnings.some((l) => normalizeLearningFingerprint(l.text) === fingerprint)) {
      return;
    }
    learnings.push(learning);
    await writeJsonFile(filePath, learnings);
  } catch (err) {
    log.warn("Failed to append learning to state", { error: String(err) });
  }
}

export async function readStateFiles(stateDir: string, sessionKey: string): Promise<StateFiles> {
  const dir = resolveStateDir(stateDir, sessionKey);

  const [decisions, thread, rawResources, open_items, learnings] = await Promise.all([
    readJsonFile<StateFiles["decisions"]>(path.join(dir, "decisions.json"), []),
    readJsonFile<StateFiles["thread"]>(path.join(dir, "thread.json"), []),
    readJsonFile<Record<string, unknown>>(path.join(dir, "resources.json"), {}),
    readJsonFile<StateFiles["open_items"]>(path.join(dir, "open_items.json"), []),
    readJsonFile<StateFiles["learnings"]>(path.join(dir, "learnings.json"), []),
  ]);
  const resources = normalizeResources(rawResources);

  return { decisions, thread, resources, open_items, learnings };
}

export async function writeLastToolCallToState(
  stateDir: string,
  sessionKey: string,
  toolCall: { name: string; paramsSummary: string },
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  await fs.promises.mkdir(dir, { recursive: true });
  await writeJsonFile(path.join(dir, "last_tool_call.json"), toolCall);
}

export async function readLastToolCallFromState(
  stateDir: string,
  sessionKey: string,
): Promise<{ name: string; paramsSummary: string } | null> {
  const dir = resolveStateDir(stateDir, sessionKey);
  return readJsonFile<{ name: string; paramsSummary: string } | null>(
    path.join(dir, "last_tool_call.json"),
    null,
  );
}

export async function writeThreadSnapshot(
  stateDir: string,
  sessionKey: string,
  snapshot: ThreadSnapshot,
): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);
  await writeJsonFile(path.join(dir, "thread_snapshot.json"), snapshot);
}

export async function readThreadSnapshot(
  stateDir: string,
  sessionKey: string,
): Promise<ThreadSnapshot | null> {
  const dir = resolveStateDir(stateDir, sessionKey);
  return readJsonFile<ThreadSnapshot | null>(
    path.join(dir, "thread_snapshot.json"),
    null,
  );
}

export async function resetStateFiles(stateDir: string, sessionKey: string): Promise<void> {
  const dir = resolveStateDir(stateDir, sessionKey);

  try {
    await Promise.all([
      writeJsonFile(path.join(dir, "decisions.json"), []),
      writeJsonFile(path.join(dir, "thread.json"), []),
      writeJsonFile(path.join(dir, "resources.json"), emptyResources()),
      writeJsonFile(path.join(dir, "open_items.json"), []),
      writeJsonFile(path.join(dir, "learnings.json"), []),
      // Clear last_tool_call so stale values don't leak across compactions
      fs.promises.unlink(path.join(dir, "last_tool_call.json")).catch(() => {}),
      // Clear thread snapshot — will be rebuilt from post-compaction messages
      fs.promises.unlink(path.join(dir, "thread_snapshot.json")).catch(() => {}),
    ]);
  } catch (err) {
    log.warn("Failed to reset state files", { error: String(err) });
  }
}
