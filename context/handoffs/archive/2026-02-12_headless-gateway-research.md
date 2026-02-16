# Handoff: Headless Gateway on Windows

## Status: RESEARCH COMPLETE — Awaiting Decision

The user's next question: **"Is this worth it? Is this a meaningful addition?"**

## Context

The gateway runs as a Windows Scheduled Task via `gateway.cmd`. The `.cmd` file inherently opens a visible console window that stays on screen permanently. The user wants the gateway to be truly invisible on startup.

Additionally, `DEFAULT_LOG_DIR` in `src/logging/logger.ts` is hardcoded to `/tmp/openclaw` which doesn't work on Windows.

## Research Summary

Three approaches were evaluated with Codex (gpt-5.3-codex, xhigh reasoning). Codex thread: `019c4f83-f573-7eb3-8e52-0a6789a31248`.

### Recommended: Approach B+ (VBS wrapper + PID-aware stop/restart)

| Approach | Complexity | Risk | Architecture Impact |
|---|---|---|---|
| A: Self-daemonization (`detached` + `windowsHide`) | High | High | Breaks schtasks supervisor model — stop/restart/status all need rewriting |
| B+: VBS wrapper + PID-based stop fallback | Medium | Low | Keeps existing daemon adapter, adds VBS + stop hardening |
| C: FreeConsole() / ShowWindow | Medium-High | Medium-High | Needs native dependency — Codex confirmed there is NO pure Node.js way to call FreeConsole() |

### Why B+:
- VBS runs synchronously (`True` = wait), so Task Scheduler status stays meaningful
- Existing schtasks lifecycle mostly preserved — install, status, runtime queries all work as-is
- The process tree termination concern (the original VBS weakness) is solved by adding `taskkill /F /T /PID <lock-pid>` as fallback in the stop path. OpenClaw already writes a gateway lock file with the PID at `src/infra/gateway-lock.ts`
- Restart = kill child tree via PID, then `schtasks /Run` to relaunch

### Why NOT A (self-daemonization):
- Parent exits immediately → Task Scheduler marks task "completed" while gateway still runs → status lies
- `schtasks /End` becomes a no-op → stop/restart CLI commands break
- Need startup handshake, PID control, status synthesis — too many touchpoints for the benefit

### Why NOT C (FreeConsole):
- No way to call Win32 `FreeConsole()` from Node.js without a native dependency (ffi-napi, koffi, or custom N-API addon)
- PowerShell interop only detaches the PowerShell process, not the calling Node process
- `GetConsoleWindow` is marked legacy by Microsoft

## Scope of B+ (if proceeding)

### Files to modify:
- `src/daemon/schtasks.ts` — VBS generator (`buildLauncherVbs`), `.cmd` stdout/stderr redirect, install/uninstall VBS handling, PID-based stop fallback via `taskkill /F /T /PID`
- `src/daemon/paths.ts` — `resolveGatewayLogDir()` helper
- `src/logging/logger.ts` — Fix `DEFAULT_LOG_DIR` on Windows to use `~/.openclaw/logs/`
- `src/infra/gateway-lock.ts` — Small helper to export lock PID reading for stop command

### Key implementation details (from Codex analysis):
- VBS: `WshShell.Run "cmd /c ""gateway.cmd""", 0, True` — window style 0 = hidden, True = wait
- schtasks /TR points at `wscript.exe "gateway.vbs"` (explicit WSH invocation)
- Stop: try `schtasks /End` first, fallback to `taskkill /F /T /PID <lock-pid>`
- Restart: kill child tree via PID, then `schtasks /Run`
- `readScheduledTaskCommand()` needs to strip `>> "logfile" 2>&1` redirect suffix from parsed command
- Detect WSH disabled by policy and fail with clear error

### Edge cases (from Codex):
- WSH may be disabled by corporate policy
- VBS exit code propagation via `WScript.Quit`
- Log file growth (append-only `>>` redirect) — acceptable for crash output
- Upgrade path: old installs keep `.cmd`, `install --force` switches to `.vbs`

## Other Session Work

### Damage Assessment (completed)
- Dormancy + TOFU Auth implementation from session 4 is **fully intact**
- Build passes clean (157 files, 0 errors)
- All Codex review fixes verified present in source

### Test Failures (documented, not fixed)
- **Pre-existing (4 tests):** Windows PTY (2), symlink EPERM (2) — platform limitations
- **BlueBubbles monitor (28 tests):** `applyDormancyGate` missing from test mock — dormancy implementation gap, production code correct
- **Gateway CLI coverage (9 tests):** Test harness missing `enablePositionalOptions()` on parent Command — test setup mismatch, production code correct
- User decided NOT to fix these now since production code is correct

### Session Learnings
- Previous session (2026-02-12, unlogged) ran Sonnet 4.5, did NOT follow CLAUDE.md or memory
- Transcript shows no file edits were made — dormancy/TOFU auth was not damaged
- The headless gateway plan from that session was NOT collaboratively discussed — it was pushed without user approval
