# OpenClaw Project Primer

This repo is OpenClaw: a local-first personal AI assistant you run on your own devices. It exposes a single "Gateway" control plane (WebSocket + HTTP) and connects that control plane to:
- A CLI (openclaw ...)
- A web Control UI (served by the Gateway)
- Messaging channels (Telegram, WhatsApp Web, Slack, Discord, Signal, iMessage, plus extension channels)
- "Nodes" (macOS / iOS / Android companion apps) for voice, camera, canvas, and other device capabilities
- A plugin system (extensions/*) for channels, providers, tools, hooks, and services

For senior-dev change guidance (seams + playbooks), start with `docs/architecture/GUIDEBOOK.md`.

## Mental Model

- The Gateway is the always-on control plane. Clients connect via WebSocket, call methods (RPC style), and receive events.
- Messages coming in from channels (or WebChat) are routed to an agent + session, then executed by the embedded Pi agent runtime.
- Tools are exposed to the agent (browser, canvas, nodes, sessions, message send, etc) and gated by tool policies.
- Channels are implemented as plugins (bundled under extensions/*). Each channel plugin conforms to a shared adapter contract.

## How To Use These Docs

1. Read this **Primer** for architecture orientation (Mental Model -> Repo Layout -> subsystems).
2. Use the **Seam Router** below (or the `> **Seams:**` pointer at the top of each section) to find the relevant GUIDEBOOK playbook in `docs/architecture/GUIDEBOOK.md`.
3. The GUIDEBOOK seam gives you: invariants, test citations, and a change checklist. Run those tests before and after your change.

### Reference Documents

| Document | Purpose | READ WHEN |
|----------|---------|-----------|
| GUIDEBOOK.md | Seam contracts and change playbooks | Modifying cross-cutting boundaries, running change checklists |
| AGENT_RUNTIME.md | Pi runtime, tools, policies, sandbox | Working on agent execution, tool definitions, approval flow |
| GATEWAY.md | Control plane, WS protocol, RPC, auth | Changing gateway startup, protocol, schemas, security |
| SESSIONS.md | Session keys, transcripts, routing, compaction | Fixing session routing, transcript handling, compaction |
| CHANNELS.md | Channel registry, adapter types, delivery | Adding/modifying channel adapters, fixing delivery |
| NODES.md | Companion apps, pairing, invoke contract | Working on macOS/iOS/Android nodes, device pairing |
| MEDIA_PIPELINE.md | Media tokens, hosting, image ops, transcription | Changing media handling, image processing, audio |
| OPS_UPDATES.md | Self-update, daemon, sentinel, restart safety | Changing update flow, daemon behavior, ops commands |
| architecture.md | Additional architecture notes | Deep-diving into system design |
| reading-checklist.md | Reading checklist | Onboarding or reviewing architecture |

## Seam Router

When making changes, consult `docs/architecture/GUIDEBOOK.md` for the relevant seam playbook. Use this table to find the right seam:

| If you're trying to... | Read GUIDEBOOK seam(s) |
| --- | --- |
| Change config files, state dirs, env vars, `$include`, `${VAR}` | Config + State |
| Add/change model selection, provider auth, API keys, fallback logic | Models + Providers |
| Fix memory search, change embeddings, tune recall, edit MEMORY.md | Memory + Search |
| Add/change auth, device pairing, origin checks, SSRF guards, run audit | Security + Audit |
| Add a CLI command, change subcommand routing, modify argv parsing | CLI Boot + Routing |
| Change gateway startup, add a sidecar, modify HTTP mux, fix config reload | Gateway Boot (Runtime Wiring) |
| Change WS protocol, add/modify schemas, change method dispatch or roles/scopes | Gateway Protocol + Schemas |
| Fix session keys, change transcript handling, modify compaction, fix routing | Sessions + Transcripts |
| Change inbound message pipeline, add commands/directives, fix mention gating | Auto-reply Pipeline |
| Add/change agent tools, modify tool policy, change sandbox, fix SSRF guards | Tools + Sandbox |
| Change exec approval flow, modify allowlists, fix socket approval handling | Exec Approvals |
| Change plugin loading, discovery, registration, or the plugin SDK | Plugins + Extensions |
| Add/change a channel adapter, fix delivery, modify mirroring, fix outbound | Channels + Delivery |
| Change node pairing, modify invoke contract, fix companion app commands | Nodes (Device Boundary) |
| Fix MEDIA tokens, change media hosting, modify image ops, fix transcription | Media Pipeline |
| Add/change webhook handlers, fix hook routing, handle external content | Hooks |
| Add/change cron jobs, fix scheduling, modify heartbeat runner | Cron |
| Change log formatting, add redaction patterns, fix NO_COLOR/verbosity | Logging + Redaction |
| Change Control UI assets, modify basePath, fix canvas host | Control UI + Canvas Host |
| Fix command queue, change lane config, modify exec helpers, fix signal bridging | Process + Concurrency |
| Change theme/ANSI, fix table rendering, modify progress line | Terminal + Rendering |
| Fix browser control server, change CDP config, modify port derivation | Browser Control |
| Change self-update, fix restart safety, modify sentinel/daemon behavior | Ops + Updates |
| Add/change WhatsApp, Telegram, Discord, Slack, Signal, or iMessage channel | Channels + Delivery -> Provider subsections |
| Add/change MS Teams, Voice Call, Google Chat, Matrix, LINE, or Feishu channel | Channels + Delivery -> Extension subsections |
| Change Memory-LanceDB or Memory-Core backend | Memory + Search -> Extension subsections |

## Repo Layout (Top Level)

- src/: core TypeScript implementation (CLI, gateway, agent runtime, shared utilities)
- extensions/*: bundled plugins (channels, memory backends, auth helpers, services)
- ui/: Control UI (Vite + Lit) built to dist/control-ui (generated by `pnpm ui:build`) and served by the Gateway
- apps/: companion apps (macOS, iOS, Android) and shared mobile code
- docs/: Mintlify docs content (docs.openclaw.ai)
- scripts/: build/package/test and maintenance scripts
- skills/: bundled skill packs loaded at runtime
- packages/: legacy compatibility packages (clawdbot, moltbot)
- test/: integration/e2e tests, fixtures, helpers, and mocks
- vendor/: vendored dependencies (a2ui)

## Build, Test, Dev

- Baseline runtime: Node >= 22.12
- Install: pnpm install
- Build: pnpm build (generates dist/*) + pnpm ui:build (generates dist/control-ui/*). (prepack runs both)
- Lint/format: pnpm check
- Tests: pnpm test (vitest)

Entry points:
- openclaw.mjs: Node entry that loads dist/entry.js (compiled from src/entry.ts)
- scripts/run-node.mjs: dev runner that rebuilds dist when stale, then runs openclaw.mjs

## Configuration and State

> **Seams:** Config + State

- State dir: ~/.openclaw by default (see src/config/paths.ts)
- Config file: ~/.openclaw/openclaw.json (JSON5). Can be overridden via OPENCLAW_CONFIG_PATH / OPENCLAW_STATE_DIR.

Config path and state dir resolution (src/config/paths.ts):
- State dir defaults to `~/.openclaw`, but will prefer an existing legacy state dir (`~/.clawdbot`, `~/.moltbot`, `~/.moldbot`) when the new dir does not exist.
- `OPENCLAW_STATE_DIR` (or legacy `CLAWDBOT_STATE_DIR`) overrides the state dir.
- Config path is resolved by preferring existing candidates in this order:
  - explicit `OPENCLAW_CONFIG_PATH` (or legacy `CLAWDBOT_CONFIG_PATH`)
  - state-dir-derived `openclaw.json` plus legacy filenames (`clawdbot.json`, `moltbot.json`, `moldbot.json`)
  - default locations under `~/.openclaw` and then legacy dirs
- OAuth dir defaults to `<stateDir>/credentials`, override via `OPENCLAW_OAUTH_DIR`.
- Gateway lock dir defaults to `os.tmpdir()/openclaw-<uid>` (or `openclaw` when uid is not available).

Config IO pipeline (src/config/io.ts):
1. Read config file as JSON5 (or return `{}` when missing).
2. Resolve `$include` directives (fail hard in snapshot mode; best-effort in `loadConfig()`).
3. Apply `config.env` entries into `process.env` *before* substitution, so `${VAR}` can reference config-defined vars.
4. Substitute `${VAR}` references from env (throws `MissingEnvVarError` when required vars are absent).
5. Validate with Zod + plugin validation (`validateConfigObjectWithPlugins`).
6. Apply defaults (messages/logging/sessions/agents/context pruning/compaction/model defaults).
   - `readConfigFileSnapshot()` also applies the Talk API key fallback default (`applyTalkApiKey`), but `loadConfig()` does not.
7. Normalize paths and validate that agent dirs are not duplicated (pre- and post-default checks exist).
8. Apply runtime overrides (`src/config/runtime-overrides.ts`).
9. Apply `config.env` again (final config env is applied only when env vars are not already set).
10. Optional shell env fallback: when enabled (env flag or `cfg.env.shellEnv.enabled`), attempts to load provider/channel tokens from the shell environment for a known key set.

Key config composition semantics:
- `$include` deep-merge semantics are intentional:
  - Sibling keys override included content (requires included content to be an object when siblings exist).
  - Array `$include` merges multiple files with a deep merge (objects recurse, arrays concatenate, primitives "last wins"). (`src/config/includes.test.ts`)
- `${VAR}` substitution is strict:
  - Only uppercase env var names are substituted; missing or empty env values are treated as missing and throw.
  - Escape `${VAR}` literals via `$${VAR}`. (`src/config/env-substitution.test.ts`)
- `env` block application is non-destructive:
  - It sets env vars only when the process env is unset/blank; it never overrides an existing env var. (`src/config/config.env-vars.test.ts`)

Legacy config migrations:
- Normal reads do **not** auto-migrate the on-disk config:
  - `loadConfig()` will treat legacy keys/shapes as invalid and fall back to `{}`.
  - `readConfigFileSnapshot()` reports legacy paths as `legacyIssues` and surfaces Zod/plugin `issues`, but does not rewrite the config file. (`src/config/config.legacy-config-detection.*.test.ts`)
- Migrations are explicit:
  - `migrateLegacyConfig(raw)` returns `{ config|null, changes[] }` after applying `applyLegacyMigrations` and validating the result. (`src/config/legacy-migrate.ts`, `src/config/legacy.ts`)

Config caching:
- `loadConfig()` uses a short in-process cache (default 200ms) to avoid repeated disk reads; it can be disabled with `OPENCLAW_DISABLE_CONFIG_CACHE` or `OPENCLAW_CONFIG_CACHE_MS=0`.

Config writes:
- `writeConfigFile()` validates the config, stamps `meta.lastTouchedVersion` and `meta.lastTouchedAt`, writes JSON (not JSON5), and maintains backups (`<config>.bak`, plus a bounded rotation).
- On Windows, it falls back to copy+chmod when atomic rename replacement fails.

Config schema export (UI/config surfaces):
- `buildConfigSchema()` (`src/config/schema.ts`) generates a draft-07 JSON Schema + UI hints from `OpenClawSchema`.
- It strips the built-in `channels.*` schema (leaving `channels` permissive with `additionalProperties: true`) and then merges plugin/channel schemas and UI hints, so extensions can contribute config surfaces without forking the base schema. (`src/config/schema.test.ts`)

Gateway startup additionally:
- Migrates legacy config keys (src/gateway/server.impl.ts uses config snapshot + migrateLegacyConfig)
- Enforces safe bind rules: refuses to bind non-loopback without auth configured (src/gateway/server-runtime-config.ts)

## CLI Boot (Important Nuances)

> **Seams:** CLI Boot + Routing

Entry: `src/entry.ts` -> `src/cli/run-main.ts`

Key CLI behaviors that affect upgrades:
- `src/entry.ts` will respawn itself to suppress Node's `ExperimentalWarning` by appending `--disable-warning=ExperimentalWarning` to `NODE_OPTIONS` unless `OPENCLAW_NO_RESPAWN` is set or the option is already present. This means any "early env" changes must survive a respawn.
- Windows argv is normalized aggressively (removes duplicate `node.exe` entries and strips control chars/quotes), both in `src/entry.ts` and in `src/cli/run-main.ts`.
- `OPENCLAW_PROFILE` is parsed early and applied to env before Commander parsing.
- `src/cli/run-main.ts` supports a "route-first" fast path (`src/cli/route.ts`) that runs certain commands without registering all Commander subcommands.
- Lazy subcommands are the default: `src/cli/program/register.subclis.ts` registers placeholder commands that dynamically import and then re-run parsing, unless `OPENCLAW_DISABLE_LAZY_SUBCOMMANDS` is set.
- Plugin CLI command registration is intentionally skipped for `--help`/`--version` at root, but enabled otherwise (and some subclis register plugin commands before other registration when required, e.g. pairing CLI).

argv parsing and early gates:
- argv helper behavior (`src/cli/argv.ts`, `src/cli/argv.test.ts`):
  - Flag scanning stops at `--`.
  - `--flag value` and `--flag=value` are both supported for ad-hoc parsing.
  - Values that look like negative numbers (e.g. `-1`, `-2.5`) are treated as values (not flags) for the purpose of `getFlagValue`.
  - `buildParseArgv()` normalizes "direct" invocations so the rest of the CLI can assume an argv shape like `node openclaw ...`:
    - If argv already looks like `node|bun ...` it is returned as-is.
    - If argv begins with `openclaw` (or endswith `openclaw`), it produces `["node", "openclaw", ...]`.
- Config guard (`src/cli/program/config-guard.ts`):
  - The CLI runs the doctor config flow once per process (non-interactive) before most commands.
  - If `readConfigFileSnapshot()` reports invalid config, most commands exit 1 after printing issues and a suggested `openclaw doctor --fix`.
  - A small allowlist (doctor/logs/health/help/status, plus some `openclaw gateway <subcommand>`) can proceed even when config is invalid.
- PreAction hooks (`src/cli/program/preaction.ts`):
  - Sets `process.title` to `openclaw-<topCommand>` for better process identification.
  - Emits the banner for most commands (skips update/completion/plugins update), sets global verbosity, and loads plugins for a few commands that require channel plugin access (`message`, `channels`, `directory`).
- Route-first (`src/cli/route.ts`) shares the same config gate and only loads plugins when the routed command requires them.

## Gateway (Control Plane)

> **Seams:** Gateway Boot (Runtime Wiring), Gateway Protocol + Schemas, Security + Audit

WebSocket + HTTP control plane. Manages device connections, RPC dispatch, schema validation, auth, and config reload. Port 18789 by default. Auth modes: `token` (shared secret), `password`, or `approval` (manual TOFU — trust on first use). See `GATEWAY.md` for full details including boot sequence, HTTP routing, config reload, device identity/pairing, and gateway lock.

### Manual Connection Approval (TOFU Auth)

Auth mode `"approval"` enables trust-on-first-use device authentication. New devices connect without pre-shared tokens, submit device identity (ED25519 key pair), and enter a pending pairing state. The user approves via main agent or `openclaw devices approve` CLI. Approved devices are paired with crypto keys; subsequent connections auto-authenticate by key signature.

- Config: `gateway.auth.mode: "approval"` in `src/config/types.gateway.ts` (`GatewayApprovalConfig`)
- Auth logic: `src/gateway/auth.ts` — approval mode bypass in `resolveGatewayAuth`, `authorizeGatewayConnect`
- HTTP endpoints: `src/gateway/pair-http.ts` — `POST /pair/request` (submit pairing) and `POST /pair/status` (poll approval)
- Rate limiting: `src/gateway/pair-rate-limit.ts` — per-IP and global limits for DoS protection on unauthenticated endpoint
- WS bypass: `src/gateway/server/ws-connection/message-handler.ts` — 3-line approval mode bypass after device-token check
- Gotcha: approval mode relaxes the non-loopback bind restriction (`server-runtime-config.ts`) — the gateway will bind externally without a shared secret when approval mode is configured.

## Agent Runtime

> **Seams:** Models + Providers, Tools + Sandbox, Exec Approvals, Auto-reply Pipeline

The embedded Pi runtime (`@mariozechner/pi-*` packages) wrapped by `src/agents/`. Covers core orchestration, transcript hygiene, tool policy, exec approvals, heartbeats, auth profiles, model catalog/selection/fallback, skills, inbound envelope formatting, auto-reply commands, and per-channel action tools. See `AGENT_RUNTIME.md` for full details.

### Agent Dormancy

Runtime state (not config) that allows agents to be toggled active/dormant without gateway restart. Dormant agents silently ignore all inbound channel messages. Activation records a cursor timestamp so the agent doesn't reply to conversations already handled by the user.

- State store: `src/agents/dormancy/store.ts` (JSON files at `~/.openclaw/agents/<id>/dormancy.json`)
- In-memory cache + API: `src/agents/dormancy/dormancy.ts` (`isAgentDormant`, `activateAgent`, `deactivateAgent`)
- Pipeline gate: `src/agents/dormancy/gate.ts` (`applyDormancyGate`) — inserted in every channel monitor after `resolveAgentRoute()`
- Agent tool: `src/agents/tools/dormancy-tool.ts` (`agent_dormancy`) — activate/deactivate/status, authorized via `subagents.allowAgents`
- Gotcha: dormancy is runtime state stored separately from config — config changes require gateway restart, dormancy does not.

## Sessions and Routing

> **Seams:** Sessions + Transcripts

Session keys, store/request key normalization, DM scoping, identity links, route resolution (bindings), send policy, model/verbose overrides, and session tools (list/history/send/spawn). See `SESSIONS.md` for full details.

## Outbound Messaging and Mirroring

> **Seams:** Channels + Delivery

The shared outbound layer powers agent tool sends, CLI message send, cron isolated agent delivery, and cross-session transcript mirroring.

Core files:
- src/infra/outbound/message-action-runner.ts: parses/normalizes tool params, resolves targets, enforces cross-context policy, and dispatches to plugins or core senders.
- src/infra/outbound/target-resolver.ts + src/infra/outbound/targets.ts: normalize/resolve destinations (including directory lookups and allowFrom fallback).
- src/infra/outbound/outbound-session.ts: maps outbound target ids to session keys and writes session meta (best effort) for future implicit delivery.
- src/infra/outbound/deliver.ts: adapter-driven sendText/sendMedia with chunking, Signal markdown-to-styles, bestEffort mode, and transcript mirroring.

Behavioral highlights:
- Cross-provider sends are denied by default when a toolContext is bound to another provider; config can relax this (tools.message.crossContext.*).
- sendAttachment/setGroupIcon can accept media/path/filePath and will auto-hydrate buffer and filename from the fetched bytes.
- Mirroring writes an assistant message into the resolved outbound session key so the main session transcript reflects what was sent.

## Plugins and Extensions

> **Seams:** Plugins + Extensions

Plugins are discovered and loaded at runtime via src/plugins/*.

- Bundled plugins live under extensions/* and are discovered via src/plugins/bundled-dir.ts.
- Plugin discovery reads package.json "openclaw" metadata for extension entrypoints and requires openclaw.plugin.json for config schema.
- Plugins are loaded with jiti to support TS/ESM without a separate build step (src/plugins/loader.ts). **Gotcha:** jiti's sync loader breaks packages with ESM-only transitive deps (e.g. cloudflare .mjs internals, @google/genai). For plugins with heavy/ESM dependency trees, pre-compile to `.cjs` with esbuild (all deps external) — the loader detects `.cjs` files and loads them via `createRequire` instead of jiti, so runtime `import()` calls use Node's native ESM resolver.
- openclaw/plugin-sdk is aliased into the core source/dist so plugins can import shared types/utilities.
- Discovery order defines precedence for duplicate ids: config > workspace > global > bundled (src/plugins/discovery.ts, src/plugins/loader.ts).
- Bundled plugins are disabled by default unless explicitly enabled in config (except the selected memory-slot plugin) (src/plugins/config-state.ts).
- Plugin registration must be synchronous: if a plugin register/activate export returns a Promise, it is intentionally ignored and a warning is emitted (src/plugins/loader.ts).
- Optional plugin tools are only exposed when explicitly allowlisted by tool name, plugin id, or `group:plugins` (src/plugins/tools.ts).
- Plugins can register typed lifecycle hooks (`api.on(...)`) and pre-agent message/tool filters (src/plugins/hooks.ts).
- Plugins can register `/commands` that bypass the agent; these are matched before built-ins and before LLM invocation (src/plugins/commands.ts).

Registry outputs include:
- Channel plugins (used by the Gateway and CLI)
- Tool factories
- Hook registrations
- Gateway method handlers
- HTTP handlers/routes
- CLI command registrars
- Background services

## Channels (Registry and Types)

> **Seams:** Channels + Delivery (+ provider/extension playbooks)

Core channel plumbing in `src/channels/*`. Covers channel docking/metadata, chat type normalization, config matching, allowlists, plugin contract (adapter split), registry/catalogs, config schema/mutation helpers, message actions, media limits, status snapshots, pairing helpers, onboarding, directory lists, outbound adapters, target normalization, session bookkeeping, sender identity, mention gating, and channel docks. See `CHANNELS.md` for full details.

## Control UI

> **Seams:** Control UI + Canvas Host

- UI app lives in ui/ (Vite + Lit) and builds to dist/control-ui (generated build output; not present on a fresh checkout).
- Gateway serves it with strict anti-clickjacking headers (src/gateway/control-ui.ts).
- The UI base path is configurable (gateway.controlUi.basePath), and a small config is injected into index.html at serve time.

## Nodes (Companion Apps)

> **Seams:** Nodes (Device Boundary)

Device boundary clients connecting as role=node. Covers the gateway contract (role/method gating, identity, pairing, invoke flow, event flow, command allowlists), node-host implementation, and companion app implementations (iOS, Android, macOS). See `NODES.md` for full details.

## Media Pipeline

> **Seams:** Media Pipeline

Three media contracts: MEDIA tokens (output contract), temporary media storage/hosting, and media understanding (inbound pre-processing). Covers MIME detection, image optimization, audio transcription, and file extraction. See `MEDIA_PIPELINE.md` for full details.

## Ops and Updates

> **Seams:** Ops + Updates

Self-update, restart safety, and how update/config-apply results are carried across restarts. Covers update channels, install kinds, CLI update flow, core update runner, startup update checks, restart mechanisms (SIGUSR1 + service), and restart sentinel. See `OPS_UPDATES.md` for full details.

Windows daemon (schtasks):
- `gateway install` uses `schtasks /Create /SC ONLOGON` which requires an Administrator terminal. This is inherent to the ONLOGON trigger — not a stored/configurable state.
- The VBS launcher (`gateway.vbs`) wraps the `.cmd` script via `WshShell.Run(..., 0, True)` to hide the console window. `wscript.exe` is the `/TR` target, not the `.cmd` directly.
- `gateway stop` uses `schtasks /End` + PID-based `taskkill /F /T /PID` fallback (reads PID from gateway lock file).
- Gotcha: `gateway install` and `gateway uninstall` require admin elevation; `stop`/`restart`/`status` do not.
- Gotcha: schtasks scripts hardcode CLI args (port, env vars) at install time. Config changes (e.g. `gateway.port`) are NOT reflected until `gateway install --force` is re-run.
- Gotcha: `startGatewayServer` stamps `process.env.OPENCLAW_GATEWAY_PORT` on each start. Code that re-resolves the port in-process must bypass this stamped env var (pass `{}` as env to `resolveGatewayPort`) or it will get the stale value.
- Gotcha: **Stale PATH in long-running services.** Process environment (including PATH) is a birth-time snapshot — it never updates in-place. Software installed after the gateway starts (e.g. `winget install ffmpeg`) modifies the registry PATH for future processes, but the running gateway (and its SIGUSR1 restarts) keep the old PATH. External tools that shell out to binaries (e.g. Whisper → ffmpeg) will fail with `FileNotFoundError` even though the binary is installed. Fix: use wrapper scripts that explicitly prepend the binary's directory to PATH, or reboot/re-login to refresh the service environment.
- Gotcha: **`.cmd`/`.bat` files require shell mediation on Windows.** Node's `execFile` and `spawn` (without `shell` option) cannot execute `.cmd`/`.bat` scripts — a Windows platform limitation. `src/process/exec.ts` detects these extensions via `needsShellMediation()` and adds `shell: true` to both `runExec` and `runCommandWithTimeout`.

## Memory + Search

> **Seams:** Memory + Search (+ Memory-LanceDB and Memory-Core extension playbooks)

Semantic search over workspace markdown files (MEMORY.md, memory/*.md) and optionally session transcripts. Uses SQLite + sqlite-vec (vector) + FTS5 (keyword) for hybrid search; embedding providers (OpenAI, Gemini, local llama.cpp) selected via "auto" cascade.

- Manager + search: `src/memory/manager.ts`, `src/memory/search-manager.ts`, `src/memory/hybrid.ts`
- Schema + storage: `src/memory/memory-schema.ts`, `src/memory/sqlite.ts`, `src/memory/sqlite-vec.ts`
- Embeddings: `src/memory/embeddings.ts`, `src/memory/embeddings-openai.ts`, `src/memory/embeddings-gemini.ts`
- Tools: `src/agents/tools/memory-tool.ts` (memory_search, memory_get)
- Extensions: `extensions/memory-core/` (builtin backend), `extensions/memory-lancedb/` (LanceDB alternative)
- Gotcha: embedding provider "auto" cascade silently picks whichever API key is available first — a missing key changes recall quality without error.

## Security + Audit

> **Seams:** Security + Audit

Gateway auth (device identity, origin checks, role/scope enforcement), SSRF guards for outbound fetches, exec approval policies, and the `openclaw audit` command.

- Audit + fix: `src/security/audit.ts`, `src/security/fix.ts`
- External content wrapping: `src/security/external-content.ts`
- Gateway auth: `src/gateway/auth.ts`, `src/gateway/device-auth.ts`, `src/gateway/origin-check.ts`
- SSRF: `src/infra/net/ssrf.ts`, `src/infra/net/fetch-guard.ts`
- Gotcha: binding a non-loopback host without auth configured is silently refused at startup — check `server-runtime-config.ts` bind rules. Exception: approval mode (`gateway.auth.mode: "approval"`) is allowed to bind externally without a shared secret.

## Hooks

> **Seams:** Hooks

HTTP webhook endpoints that fire on lifecycle events (message received, agent start/end, tool calls, etc). Configured under `hooks.*` and served by the gateway HTTP mux.

- Hook definitions + dispatch: `src/hooks/hooks.ts`, `src/hooks/internal-hooks.ts`
- Bundled hooks: `src/hooks/bundled/` (session-memory, etc.)
- Gateway wiring: `src/gateway/hooks.ts`, `src/gateway/server/hooks.ts`
- Gotcha: hook routing is first-match in the HTTP mux — a misconfigured hook path can shadow other endpoints.

## Cron

> **Seams:** Cron

Scheduled agent runs. Jobs stored in `<stateDir>/cron/jobs.json`, executed by the gateway cron runner on the Cron command lane.

- Scheduler + runner: `src/cron/schedule.ts`, `src/cron/service.ts`
- Job store: `src/cron/store.ts`, `src/cron/types.ts`
- Gateway wiring: `src/gateway/server-cron.ts`, `src/gateway/server-methods/cron.ts`
- Agent tool: `src/agents/tools/cron-tool.ts`
- Gotcha: cron runs on the Cron lane — if lane `maxConcurrent` is 1 (default), a slow job blocks all subsequent scheduled runs.

## Logging + Redaction

> **Seams:** Logging + Redaction

Centralized logging through `src/logger.ts` with structured levels (verbose/debug/info/warn/error). Redaction strips secrets from log output before writing.

- Logger singleton: `src/logger.ts`
- Redaction: `src/logging/redact.ts`
- Gateway WS logging: `src/gateway/ws-logging.ts`
- Gotcha: adding a new secret pattern to redaction requires updating `redact.ts` — missing patterns leak secrets in verbose mode.

## Process + Concurrency

> **Seams:** Process + Concurrency

Execution is serialized within command lanes (FIFO queues with configurable maxConcurrent). Built-in lanes: Main, Cron, Subagent, Nested.

- Command queue + lanes: `src/process/command-queue.ts`, `src/process/lanes.ts`
- Exec helpers: `src/process/exec.ts`, `src/process/spawn-utils.ts`
- Signal bridging: `src/process/child-process-bridge.ts`
- Gateway lane config: `src/gateway/server-lanes.ts`
- Gotcha: lane starvation — a long-running Main lane task blocks all subsequent Main lane requests (including heartbeats).

## Terminal + Rendering

> **Seams:** Terminal + Rendering

Terminal rendering respects NO_COLOR/FORCE_COLOR, uses ANSI-aware table layout, and provides OSC-8 clickable links in supported terminals.

- Theme + color: `src/terminal/theme.ts`, `src/terminal/palette.ts`
- ANSI stripping + visible width: `src/terminal/ansi.ts`
- Table rendering: `src/terminal/table.ts`
- Doc links: `src/terminal/links.ts`
- Progress line: `src/terminal/progress-line.ts`
- Gotcha: ANSI escape sequences leak into CI logs when NO_COLOR is not respected — always test with `NO_COLOR=1`.

## Browser Control

> **Seams:** Browser Control

Local Chrome/Chromium instance managed via CDP for agent browser tools. Start/stop are idempotent; always binds to 127.0.0.1.

- Server lifecycle: `src/browser/server.ts`
- Config + port derivation: `src/browser/config.ts`
- Runtime state + routes: `src/browser/server-context.ts`
- Gateway sidecar wiring: `src/gateway/server-startup.ts`
- Gotcha: port is derived from the gateway port — if `OPENCLAW_GATEWAY_PORT` is wrong at startup, the browser sidecar binds to the wrong port.

## Where To Start

For **architecture orientation**, read this document top-down (Mental Model -> Repo Layout -> key subsystems).

For **change guidance** (invariants, test files, checklists), consult `docs/architecture/GUIDEBOOK.md`. Use the Seam Router table above to find the right seam, or look for the `> **Seams:**` pointer at the top of each section in this document.

For **deep code reading**, start with:
1. src/entry.ts, src/cli/run-main.ts, src/cli/program/*
2. src/gateway/server.impl.ts, src/gateway/server-methods.ts, src/gateway/server-http.ts
3. src/plugins/loader.ts, src/plugins/registry.ts, src/plugins/discovery.ts
4. src/agents/pi-tools.ts, src/agents/pi-embedded-subscribe.ts
5. One channel plugin end-to-end (e.g. extensions/telegram/src/channel.ts)

## Gateway RPC Findings (2026-02-08)

Key control-plane details discovered while exhaustively reading src/gateway/server-methods/* plus direct integrators/tests:

- Authorization is method-based and scope-based (src/gateway/server-methods.ts). READ and WRITE are explicit allowlists; admin-only methods include config.*, wizard.*, update.*, channels.logout, skills.install/update, cron mutators, and session mutators.
- poll is implemented (in src/gateway/server-methods/send.ts) but is not advertised (src/gateway/server-methods-list.ts) and is not in the READ/WRITE allowlists, so it is effectively hidden and admin-only.
- browser.request is manually validated in the handler and has no corresponding protocol schema entry under src/gateway/protocol/schema/; it can route either to a browser-capable node via nodeRegistry.invoke("browser.proxy") or to the local browser control dispatcher.
- Channel docking is intentional: the channels.status result schema tolerates additional fields (`additionalProperties: true`) so plugins can ship new status fields without protocol updates.
- channels.logout delegates to the channel plugin logout hook; plugins may mutate config as part of logout, but the gateway requires the config snapshot to be valid before proceeding.
- update.run returns a successful RPC response payload even when the update result is status: "error"; clients must inspect payload.result.status.
