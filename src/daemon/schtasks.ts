import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { GatewayServiceRuntime } from "./service-runtime.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { formatGatewayServiceDescription, resolveGatewayWindowsTaskName } from "./constants.js";
import { resolveGatewayLogDir, resolveGatewayStateDir } from "./paths.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { readGatewayLockPid } from "../infra/gateway-lock.js";

const execFileAsync = promisify(execFile);

const formatLine = (label: string, value: string) => {
  const rich = isRich();
  return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
};

function resolveTaskName(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_WINDOWS_TASK_NAME?.trim();
  if (override) {
    return override;
  }
  return resolveGatewayWindowsTaskName(env.OPENCLAW_PROFILE);
}

export function resolveTaskScriptPath(env: Record<string, string | undefined>): string {
  const override = env.OPENCLAW_TASK_SCRIPT?.trim();
  if (override) {
    return override;
  }
  const scriptName = env.OPENCLAW_TASK_SCRIPT_NAME?.trim() || "gateway.cmd";
  const stateDir = resolveGatewayStateDir(env);
  return path.join(stateDir, scriptName);
}

export function resolveTaskLauncherPath(env: Record<string, string | undefined>): string {
  const scriptPath = resolveTaskScriptPath(env);
  const launcherPath = scriptPath.replace(/\.cmd$/i, ".vbs");
  if (launcherPath === scriptPath) {
    return `${scriptPath}.vbs`;
  }
  return launcherPath;
}

function buildLauncherVbs(cmdScriptPath: string): string {
  const escaped = cmdScriptPath.replace(/"/g, '""');
  const lines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    `exitCode = WshShell.Run("cmd /c ""${escaped}""", 0, True)`,
    "Set WshShell = Nothing",
    "WScript.Quit exitCode",
  ];
  return lines.join("\r\n") + "\r\n";
}

function quoteCmdArg(value: string): string {
  if (!/[ \t"]/g.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function resolveTaskUser(env: Record<string, string | undefined>): string | null {
  const username = env.USERNAME || env.USER || env.LOGNAME;
  if (!username) {
    return null;
  }
  if (username.includes("\\")) {
    return username;
  }
  const domain = env.USERDOMAIN;
  if (domain) {
    return `${domain}\\${username}`;
  }
  return username;
}

function parseCommandLine(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let inQuotes = false;

  for (const char of value) {
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    args.push(current);
  }
  return args;
}

export async function readScheduledTaskCommand(env: Record<string, string | undefined>): Promise<{
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
} | null> {
  const scriptPath = resolveTaskScriptPath(env);
  try {
    const content = await fs.readFile(scriptPath, "utf8");
    let workingDirectory = "";
    let commandLine = "";
    const environment: Record<string, string> = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      if (line.startsWith("@echo")) {
        continue;
      }
      if (line.toLowerCase().startsWith("rem ")) {
        continue;
      }
      if (line.toLowerCase().startsWith("set ")) {
        const assignment = line.slice(4).trim();
        const index = assignment.indexOf("=");
        if (index > 0) {
          const key = assignment.slice(0, index).trim();
          const value = assignment.slice(index + 1).trim();
          if (key) {
            environment[key] = value;
          }
        }
        continue;
      }
      if (line.toLowerCase().startsWith("cd /d ")) {
        workingDirectory = line.slice("cd /d ".length).trim().replace(/^"|"$/g, "");
        continue;
      }
      commandLine = line;
      break;
    }
    if (!commandLine) {
      return null;
    }
    // Strip stdout/stderr redirect suffix (added by VBS launcher install)
    commandLine = commandLine.replace(/\s*(?:1?>>?)\s*(?:"[^"]+"|[^\s]+)\s*(?:2>\s*&1)?\s*$/, "");
    if (!commandLine) {
      return null;
    }
    return {
      programArguments: parseCommandLine(commandLine),
      ...(workingDirectory ? { workingDirectory } : {}),
      ...(Object.keys(environment).length > 0 ? { environment } : {}),
    };
  } catch {
    return null;
  }
}

export type ScheduledTaskInfo = {
  status?: string;
  lastRunTime?: string;
  lastRunResult?: string;
};

export function parseSchtasksQuery(output: string): ScheduledTaskInfo {
  const entries = parseKeyValueOutput(output, ":");
  const info: ScheduledTaskInfo = {};
  const status = entries.status;
  if (status) {
    info.status = status;
  }
  const lastRunTime = entries["last run time"];
  if (lastRunTime) {
    info.lastRunTime = lastRunTime;
  }
  const lastRunResult = entries["last run result"];
  if (lastRunResult) {
    info.lastRunResult = lastRunResult;
  }
  return info;
}

function buildTaskScript({
  description,
  programArguments,
  workingDirectory,
  environment,
  logFile,
}: {
  description?: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  logFile?: string;
}): string {
  const lines: string[] = ["@echo off"];
  if (description?.trim()) {
    lines.push(`rem ${description.trim()}`);
  }
  if (workingDirectory) {
    lines.push(`cd /d ${quoteCmdArg(workingDirectory)}`);
  }
  if (environment) {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) {
        continue;
      }
      lines.push(`set ${key}=${value}`);
    }
  }
  const command = programArguments.map(quoteCmdArg).join(" ");
  if (logFile) {
    lines.push(`${command} >> ${quoteCmdArg(logFile)} 2>&1`);
  } else {
    lines.push(command);
  }
  return `${lines.join("\r\n")}\r\n`;
}

async function execSchtasks(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("schtasks", args, {
      encoding: "utf8",
      windowsHide: true,
    });
    return {
      stdout: String(stdout ?? ""),
      stderr: String(stderr ?? ""),
      code: 0,
    };
  } catch (error) {
    const e = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
      message?: unknown;
    };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr:
        typeof e.stderr === "string" ? e.stderr : typeof e.message === "string" ? e.message : "",
      code: typeof e.code === "number" ? e.code : 1,
    };
  }
}

async function assertSchtasksAvailable() {
  const res = await execSchtasks(["/Query"]);
  if (res.code === 0) {
    return;
  }
  const detail = res.stderr || res.stdout;
  throw new Error(`schtasks unavailable: ${detail || "unknown error"}`.trim());
}

export async function installScheduledTask({
  env,
  stdout,
  programArguments,
  workingDirectory,
  environment,
  description,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string | undefined>;
  description?: string;
}): Promise<{ scriptPath: string }> {
  await assertSchtasksAvailable();
  const scriptPath = resolveTaskScriptPath(env);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const taskDescription =
    description ??
    formatGatewayServiceDescription({
      profile: env.OPENCLAW_PROFILE,
      version: environment?.OPENCLAW_SERVICE_VERSION ?? env.OPENCLAW_SERVICE_VERSION,
    });
  const logDir = resolveGatewayLogDir(env);
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, "gateway-console.log");

  const script = buildTaskScript({
    description: taskDescription,
    programArguments,
    workingDirectory,
    environment,
    logFile,
  });
  await fs.writeFile(scriptPath, script, "utf8");

  // Write VBS launcher for headless operation
  const launcherPath = resolveTaskLauncherPath(env);
  const vbsContent = buildLauncherVbs(scriptPath);
  await fs.writeFile(launcherPath, vbsContent, "utf8");

  // Verify Windows Script Host is available
  const testVbs = path.join(path.dirname(launcherPath), "wsh-test.vbs");
  try {
    await fs.writeFile(testVbs, "WScript.Quit 0\r\n", "utf8");
    await execFileAsync("wscript.exe", [testVbs], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    await fs.unlink(launcherPath).catch(() => {});
    throw new Error(
      "Windows Script Host is disabled or unavailable. The gateway cannot run headless. " +
      "Check Group Policy: Computer Configuration > Administrative Templates > Windows Components > Windows Script Host.",
    );
  } finally {
    await fs.unlink(testVbs).catch(() => {});
  }

  const taskName = resolveTaskName(env);
  const quotedScript = `wscript.exe ${quoteCmdArg(launcherPath)}`;
  const baseArgs = [
    "/Create",
    "/F",
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/TN",
    taskName,
    "/TR",
    quotedScript,
  ];
  const taskUser = resolveTaskUser(env);
  let create = await execSchtasks(
    taskUser ? [...baseArgs, "/RU", taskUser, "/NP", "/IT"] : baseArgs,
  );
  if (create.code !== 0 && taskUser) {
    create = await execSchtasks(baseArgs);
  }
  if (create.code !== 0) {
    const detail = create.stderr || create.stdout;
    const hint = /access is denied/i.test(detail)
      ? " Run PowerShell as Administrator or rerun without installing the daemon."
      : "";
    throw new Error(`schtasks create failed: ${detail}${hint}`.trim());
  }

  await execSchtasks(["/Run", "/TN", taskName]);
  // Ensure we don't end up writing to a clack spinner line (wizards show progress without a newline).
  stdout.write("\n");
  stdout.write(`${formatLine("Installed Scheduled Task", taskName)}\n`);
  stdout.write(`${formatLine("Task script", scriptPath)}\n`);
  stdout.write(`${formatLine("VBS launcher", launcherPath)}\n`);
  stdout.write(`${formatLine("Console log", logFile)}\n`);
  return { scriptPath };
}

export async function uninstallScheduledTask({
  env,
  stdout,
}: {
  env: Record<string, string | undefined>;
  stdout: NodeJS.WritableStream;
}): Promise<void> {
  await assertSchtasksAvailable();
  const taskName = resolveTaskName(env);
  await execSchtasks(["/Delete", "/F", "/TN", taskName]);

  const scriptPath = resolveTaskScriptPath(env);
  try {
    await fs.unlink(scriptPath);
    stdout.write(`${formatLine("Removed task script", scriptPath)}\n`);
  } catch {
    stdout.write(`Task script not found at ${scriptPath}\n`);
  }

  const launcherPath = resolveTaskLauncherPath(env);
  try {
    await fs.unlink(launcherPath);
    stdout.write(`${formatLine("Removed VBS launcher", launcherPath)}\n`);
  } catch {
    // VBS launcher may not exist (pre-VBS installs) — silent
  }
}

function isTaskNotRunning(res: { stdout: string; stderr: string; code: number }): boolean {
  const detail = (res.stderr || res.stdout).toLowerCase();
  return detail.includes("not running");
}

async function killGatewayProcessTree(
  env: Record<string, string | undefined>,
): Promise<boolean> {
  try {
    const pid = await readGatewayLockPid(env as NodeJS.ProcessEnv);
    if (!pid) {
      return false;
    }
    await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    // taskkill may fail if process already exited — that's fine
    return false;
  }
}

export async function stopScheduledTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSchtasksAvailable();
  const resolvedEnv = env ?? (process.env as Record<string, string | undefined>);
  const taskName = resolveTaskName(resolvedEnv);
  const res = await execSchtasks(["/End", "/TN", taskName]);
  if (res.code === 0 || isTaskNotRunning(res)) {
    // schtasks /End succeeded or task wasn't running — try PID cleanup as well
    await killGatewayProcessTree(resolvedEnv);
    stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
    return;
  }
  // schtasks /End failed — fall back to PID-based kill
  const killed = await killGatewayProcessTree(resolvedEnv);
  if (!killed) {
    throw new Error(`schtasks end failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Stopped Scheduled Task", taskName)}\n`);
}

export async function restartScheduledTask({
  stdout,
  env,
}: {
  stdout: NodeJS.WritableStream;
  env?: Record<string, string | undefined>;
}): Promise<void> {
  await assertSchtasksAvailable();
  const resolvedEnv = env ?? (process.env as Record<string, string | undefined>);
  const taskName = resolveTaskName(resolvedEnv);
  // Kill via schtasks /End + PID fallback to ensure full process tree is down
  await execSchtasks(["/End", "/TN", taskName]);
  await killGatewayProcessTree(resolvedEnv);
  const res = await execSchtasks(["/Run", "/TN", taskName]);
  if (res.code !== 0) {
    throw new Error(`schtasks run failed: ${res.stderr || res.stdout}`.trim());
  }
  stdout.write(`${formatLine("Restarted Scheduled Task", taskName)}\n`);
}

export async function isScheduledTaskInstalled(args: {
  env?: Record<string, string | undefined>;
}): Promise<boolean> {
  await assertSchtasksAvailable();
  const taskName = resolveTaskName(args.env ?? (process.env as Record<string, string | undefined>));
  const res = await execSchtasks(["/Query", "/TN", taskName]);
  return res.code === 0;
}

export async function readScheduledTaskRuntime(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<GatewayServiceRuntime> {
  try {
    await assertSchtasksAvailable();
  } catch (err) {
    return {
      status: "unknown",
      detail: String(err),
    };
  }
  const taskName = resolveTaskName(env);
  const res = await execSchtasks(["/Query", "/TN", taskName, "/V", "/FO", "LIST"]);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim();
    const missing = detail.toLowerCase().includes("cannot find the file");
    return {
      status: missing ? "stopped" : "unknown",
      detail: detail || undefined,
      missingUnit: missing,
    };
  }
  const parsed = parseSchtasksQuery(res.stdout || "");
  const statusRaw = parsed.status?.toLowerCase();
  const status = statusRaw === "running" ? "running" : statusRaw ? "stopped" : "unknown";
  return {
    status,
    state: parsed.status,
    lastRunTime: parsed.lastRunTime,
    lastRunResult: parsed.lastRunResult,
  };
}
