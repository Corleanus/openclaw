# Ops and Updates
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Ops + Updates

This seam covers self-update, restart safety, and how update/config-apply results are carried across restarts.

Primary code:
- CLI UX: `src/cli/update-cli.ts`, `src/cli/daemon-cli/lifecycle.ts`
- Update core: `src/infra/update-runner.ts`, `src/infra/update-check.ts`, `src/infra/update-startup.ts`, `src/infra/update-channels.ts`, `src/infra/update-global.ts`
- Restart: `src/infra/restart.ts`, `src/cli/gateway-cli/run-loop.ts`, `src/macos/gateway-daemon.ts`
- Daemon/service adapters: `src/daemon/service.ts`, `src/daemon/service-env.ts`, `src/daemon/launchd.ts`, `src/daemon/systemd.ts`, `src/daemon/schtasks.ts`
- Restart sentinel: `src/infra/restart-sentinel.ts`, `src/gateway/server-restart-sentinel.ts`, gateway mutators `src/gateway/server-methods/update.ts` and `src/gateway/server-methods/config.ts`

### Update Channels and Install Kinds

Update channels are normalized to `stable | beta | dev` (`src/infra/update-channels.ts`):
- `stable` maps to npm `latest` (package installs) or latest stable git tag (git installs).
- `beta` maps to npm `beta` but can fall back to `latest` when beta is older than stable; similarly, git beta can fall back to stable when the newest `-beta` tag is older.
- `dev` maps to git `main` (detected via branch or default).

Install kind is inferred from the current root (`checkUpdateStatus` in `src/infra/update-check.ts`):
- `git` when the root is the git toplevel.
- `package` otherwise (typically a global npm/pnpm/bun install).

### CLI: `openclaw update` and Switching Sources

`openclaw update status`:
- Uses `checkUpdateStatus(...)` plus `resolveEffectiveUpdateChannel(...)` to show the effective channel label derived from config (highest priority) or from git tag/branch (fallback), and can emit a JSON report.

`openclaw update` (`src/cli/update-cli.ts`):
- `--channel dev` on a package install switches to a git checkout:
  - Ensures a checkout exists at `OPENCLAW_GIT_DIR` (or default `~/.openclaw`) and clones if missing.
  - Runs `runGatewayUpdate({ cwd: <gitDir> })` and then globally installs that directory so `openclaw` resolves to the git checkout.
- `--channel stable|beta` on a git install switches to a package install:
  - Detects the global package manager and installs `<pkg>@<tag>`.
  - When it can locate `dist/entry.js` under the global package root, it runs `doctor --non-interactive` using that entry path.
- Downgrades require confirmation (can break configuration). Non-interactive runs must pass `--yes` or they error.
- `--tag` applies only to npm/package updates; git updates ignore it and print a note.
- After a successful update, it normalizes plugin install state for the channel (`syncPluginsForUpdateChannel`, `updateNpmInstalledPlugins`) and may rewrite config, then updates completion cache and may prompt to install shell completion.
- Optional restart: by default it tries to restart the installed gateway service via daemon lifecycle (`runDaemonRestart`), and then runs doctor again with `OPENCLAW_UPDATE_IN_PROGRESS=1` set during the doctor run.

### Core Update Runner: `runGatewayUpdate`

`runGatewayUpdate()` (`src/infra/update-runner.ts`) is the shared engine used by both the CLI and gateway RPC.

Mode selection:
- Prefers git mode when it can resolve a git root that is also an OpenClaw package root (package.json name `openclaw`).
- Otherwise attempts package-manager mode by detecting whether the current root is under the global roots returned by `npm root -g`, `pnpm root -g`, or Bun global root, using realpath comparisons.
- If no git root and no package manager root can be detected, it returns `{ status: "skipped", reason: "not-git-install" }`.

Git mode invariants (tests: `src/infra/update-runner.test.ts`):
- Refuses to update if the worktree is dirty, excluding `dist/control-ui/` (generated UI build output; `git status --porcelain -- :!dist/control-ui/`).
- `dev` channel:
  - Requires an upstream branch.
  - Fetches and then runs a detached preflight worktree at the upstream SHA.
  - Tries up to 10 candidate commits, running install + lint + build in the worktree, and selects the first passing commit.
  - Rebases the main worktree onto that selected commit; on failure it runs `git rebase --abort`.
- `stable|beta` channels:
  - Fetches tags and checks out a detached tag; `beta` will fall back to stable if the newest beta tag is older than stable.
- After any git update:
  - Runs deps install, `build`, and `ui:build`.
  - Restores `dist/control-ui/` to committed state to avoid leaving the repo dirty after `ui:build`.
  - Runs `openclaw doctor --non-interactive` with `OPENCLAW_UPDATE_IN_PROGRESS=1` in env.

Package-manager mode invariants:
- Cleans stale global rename directories (like `.<pkg>-...`) before running the global install to reduce failures after interrupted updates (`cleanupGlobalRenameDirs` in `src/infra/update-global.ts`).

### Update Checks on Startup

`scheduleGatewayUpdateCheck()` (`src/infra/update-startup.ts`) runs `runGatewayUpdateCheck()` in the background (best-effort).

Behavior:
- Disabled in Nix mode, in tests, and when `cfg.update.checkOnStart === false`.
- Runs at most once per 24 hours, persisting state to `<stateDir>/update-check.json`.
- Only logs "update available" once per version+tag to avoid repeated nags (tests: `src/infra/update-startup.test.ts`).

### Restart Mechanisms (In-Process vs Service)

In-process restart (SIGUSR1 loop):
- `scheduleGatewaySigusr1Restart()` (`src/infra/restart.ts`) authorizes a single restart and emits `SIGUSR1` after a delay.
- The restart authorization is consumed once (`consumeGatewaySigusr1RestartAuthorization`), so arbitrary external `SIGUSR1` does nothing by default (tests: `src/infra/restart.test.ts`).
- When `commands.restart === true`, gateway startup and config reload set a policy that allows external SIGUSR1 restarts (`setGatewaySigusr1RestartPolicy` in `src/gateway/server.impl.ts` / `src/gateway/server-reload-handlers.ts`).
- `gateway run` loops (`src/cli/gateway-cli/run-loop.ts`) and the macOS bundled gateway daemon (`src/macos/gateway-daemon.ts`) both implement: on SIGUSR1, gracefully close the server, then restart it in-process without needing an external supervisor.

Service restart (OS-level):
- `triggerOpenClawRestart()` (`src/infra/restart.ts`) attempts:
  - macOS: `launchctl kickstart -k gui/<uid>/<label>`
  - Linux: `systemctl --user restart <unit>` then `systemctl restart <unit>` fallback
  - Other platforms: no-op / unsupported
- The CLI daemon lifecycle (`src/cli/daemon-cli/lifecycle.ts`) uses platform adapters from `src/daemon/*`:
  - macOS LaunchAgent (`src/daemon/launchd.ts`)
  - Linux systemd user service (`src/daemon/systemd.ts`)
  - Windows Scheduled Task (`src/daemon/schtasks.ts`)
- `src/daemon/service-env.ts` builds a minimal, predictable `PATH` and exports `OPENCLAW_*` env values (profile/state/config/port/token/unit/label) into the service environment.

### Restart Sentinel (Persisted Outcome Across Restarts)

The restart sentinel is a small JSON file at `<stateDir>/restart-sentinel.json` (`src/infra/restart-sentinel.ts`) written before a restart-triggering operation so the next process can surface what happened.

Writers:
- `update.run` gateway RPC (`src/gateway/server-methods/update.ts`) writes a sentinel with detailed update step stats, then schedules an in-process restart.
- `config.apply` and `config.patch` (`src/gateway/server-methods/config.ts`) write a sentinel and schedule an in-process restart after writing config.

Wake behavior:
- On gateway startup, `scheduleRestartSentinelWake()` (`src/gateway/server-restart-sentinel.ts`) consumes the sentinel and tries to deliver it back to the originating sessionKey:
  - It prefers the sentinel-captured delivery context over session store state (handles the "store not flushed before restart" race).
  - If it can resolve a channel/to target, it delivers via `agentCommand(..., deliver=true, bestEffortDeliver=true)`; otherwise it enqueues a system event.
