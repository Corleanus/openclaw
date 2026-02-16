# OpenClaw Senior Developer Guidebook (Seams + Change Playbooks)

This document is the "senior engineer map" for OpenClaw: the contracts, invariants, and integration seams that matter when making upgrades or cross-cutting changes.

It is intentionally not a per-file summary. The goal is that a senior developer can:
- identify the correct module(s) to change for a behavior change
- understand what invariants/tests/other modules are likely to break
- avoid subtle regressions across channels/plugins/tools/sessions

Related docs:
- `docs/architecture/PROJECT_PRIMER.md`: architecture primer with seam routing table (start here, then pull in specific seam playbooks)
- `docs/architecture/architecture.md`: runtime wiring / component diagram notes
- `docs/architecture/reading-checklist.md`: deep-read progress tracker (file-level)

## Seam Coverage Definition

"100% seam coverage" means every cross-cutting boundary has:
1. a named owner module (entrypoint and/or adapter)
2. the contract/invariants described (what must remain true)
3. the primary tests that act as behavioral spec
4. a change playbook ("if you touch X, check Y")

## Seam Index

| Seam | Primary Code | What Breaks If You Get It Wrong |
| --- | --- | --- |
| Config + State | `src/config/*`, `src/config/io.ts`, `src/config/paths.ts` | silent misconfig, wrong state dir, auth bypass, plugin enablement drift |
| Models + Providers | `src/agents/models-config*.ts`, `src/providers/*`, auth helpers in `src/agents/*` | wrong model selection, missing auth, provider schema rejects, silent cost/limits drift |
| Memory + Search | `src/memory/*`, `extensions/memory-*` | recall missing, index corruption, high latency, storage/format drift |
| Security + Audit | `src/security/*`, `src/gateway/auth.ts`, `src/gateway/device-auth.ts`, `src/gateway/origin-check.ts` | auth bypass, unsafe defaults, sensitive data leakage |
| CLI Boot + Routing | `src/entry.ts`, `src/cli/run-main.ts`, `src/cli/route.ts`, `src/cli/program/*` | missing subcommands, plugin CLI not registered, wrong early-route behavior |
| Gateway Boot (runtime wiring) | `src/gateway/server.impl.ts`, `src/gateway/server-runtime-config.ts`, `src/gateway/server-http.ts`, `src/gateway/server-ws-runtime.ts` | production startup failures, missing sidecars, auth misconfiguration, broken HTTP endpoints |
| Gateway Protocol + Schemas | `src/gateway/protocol/*`, `src/gateway/server/ws-connection/*` | client incompatibility, schema drift, subtle auth/pairing regressions |
| Sessions + Transcripts | `src/config/sessions*`, `src/agents/session-*.ts` | session corruption, provider rejection, compaction loops, history loss |
| Auto-reply Pipeline | `src/auto-reply/*`, `src/auto-reply/reply/*` | command/directive regressions, mention/activation mistakes, unexpected sends |
| Tools + Sandbox | `src/agents/pi-tools.ts`, `src/agents/tool-policy.ts`, `src/agents/sandbox/*`, `src/infra/net/*` | SSRF escapes, unsafe exec, provider schema rejects, tool visibility regressions |
| Exec Approvals | `src/infra/exec-approvals.ts`, `src/gateway/exec-approval-manager.ts` | unsafe execution or deadlocked approval flow |
| Plugins + Extensions | `src/plugins/*`, `src/plugin-sdk/*`, `extensions/*` | plugin load order drift, broken tools/hooks/methods, runtime crashes |
| Channels + Delivery | `src/channels/*`, `src/channels/plugins/*`, provider impls (e.g. `src/web/*`) | allowlist mistakes, cross-channel behavior divergence, delivery/mirroring regressions |
| Nodes (device boundary) | `src/gateway/server-methods/nodes.ts`, `src/gateway/node-registry.ts`, `src/node-host/*`, `apps/*` | pairing issues, invoke contract drift, broken capabilities |
| Media Pipeline | `src/media/*`, `src/media-understanding/*` | broken attachments, wrong caps, sandbox leaks, provider incompat |
| Hooks | `src/hooks/*`, `src/gateway/hooks*.ts`, `src/gateway/server/hooks.ts` | webhook auth bypass, wrong routing/transform, unsafe external content handling |
| Cron | `src/cron/*`, `src/gateway/server-cron.ts`, `src/gateway/server-methods/cron.ts` | duplicate runs, missed runs, unintended sends, lane starvation |
| Logging + Redaction | `src/logging/*`, `src/logger.ts`, `src/gateway/ws-logging.ts` | secrets in logs, broken operator debugging, noisy output |
| Control UI + Canvas Host | `ui/*`, `src/gateway/control-ui.ts`, `src/canvas-host/*` | missing UI assets, broken routing/basePath, canvas host mismatch |
| Process + Concurrency | `src/process/command-queue.ts`, `src/process/lanes.ts`, `src/process/exec.ts`, `src/process/spawn-utils.ts` | lane starvation, deadlocked approvals, interleaved stdio, queue saturation |
| Terminal + Rendering | `src/terminal/theme.ts`, `src/terminal/ansi.ts`, `src/terminal/table.ts`, `src/terminal/links.ts` | garbled output, color leaking into CI, misaligned tables, broken doc links |
| Browser Control | `src/browser/server.ts`, `src/browser/config.ts`, `src/browser/server-context.ts` | orphan Chrome processes, port conflicts, security bypass via non-localhost bind, broken CDP relay |
| Ops + Updates | `src/infra/restart.ts`, `src/infra/update-*`, `src/cli/update-cli.ts`, locks | bricked installs, unsafe restarts, multi-instance corruption |
| Agent Dormancy | `src/agents/dormancy/*`, `src/agents/tools/dormancy-tool.ts` | dormant agents reply, stale message floods on wake, dormancy gate bypass, cross-agent auth failure |
| Connection Approval (TOFU Auth) | `src/gateway/pair-*.ts`, `src/gateway/auth.ts`, `src/agents/tools/gateway-security-tool.ts` | unauthenticated pairing bypass, rate limit evasion, ban evasion, password timing attacks |

## Playbooks

## Core Invariants (Do Not Accidentally Break)

Config + state (src/config):
- `$include` resolution happens before `${VAR}` substitution; `config.env` is applied to `process.env` before substitution.
- `$include` semantics are not "JSON merge patch":
  - `$include` can appear anywhere an object value is expected; it is processed recursively.
  - Sibling keys merge on top of the included object (siblings override included values).
  - Array `$include` deep-merges multiple files: objects merge recursively, arrays concatenate, primitives use "last wins". (`src/config/includes.test.ts`)
  - Include safety: max depth is 10; circular includes error. (`src/config/includes.ts`)
- `${VAR}` substitution only matches uppercase env var names (`[A-Z_][A-Z0-9_]*`); missing or empty env values throw `MissingEnvVarError`. Escape with `$${VAR}`. (`src/config/env-substitution.test.ts`)
- `cfg.env` application never overwrites existing env vars:
  - `env.vars` entries and other string keys under `env` (excluding `shellEnv`) are applied only when `process.env[key]` is unset/blank.
  - Applied twice: once before substitution (so `${VAR}` can reference config-defined env), and again after defaults/path normalization (to pick up final `env` state). (`src/config/config.env-vars.test.ts`, `src/config/io.ts`)
- Legacy config is not auto-migrated on normal reads:
  - `loadConfig()` reads + validates; legacy keys and legacy shapes make the config invalid and `loadConfig()` falls back to `{}`.
  - `readConfigFileSnapshot()` reports legacy paths as `legacyIssues` but does not rewrite the config file. (`src/config/config.legacy-config-detection.*.test.ts`)
  - Migrations are explicit via `migrateLegacyConfig` / `applyLegacyMigrations` and are used by higher-level flows (gateway startup, doctor/config RPC). (`src/config/legacy-migrate.ts`, `src/config/legacy.ts`)
- State/config paths have legacy fallback behavior (legacy state dirs and legacy config filenames); changes must not silently "move" user state.
- `loadConfig()` has a short cache window by default; changes that require immediate re-reads must consider `OPENCLAW_DISABLE_CONFIG_CACHE` / `OPENCLAW_CONFIG_CACHE_MS`.
- `writeConfigFile()` writes JSON and maintains `.bak` backups with a bounded rotation; do not introduce partial writes.

CLI boot (src/entry.ts, src/cli/*):
- `src/entry.ts` may respawn the CLI to apply `NODE_OPTIONS` warning suppression; anything that mutates env/argv must remain correct across respawn.
- Route-first (`src/cli/route.ts`) intentionally runs some commands without fully building Commander; ensure new flags/commands don't get "half parsed".
- Lazy subcommand registration (`src/cli/program/register.subclis.ts`) relies on placeholder commands that re-run parsing after dynamic import.
- PreAction hooks enforce config readiness and set global behavior:
  - `preAction` sets verbosity from `--verbose`/`--debug`, suppresses Node warnings when not verbose, emits the banner for most commands, and runs `ensureConfigReady()` before command handlers (except doctor/completion). (`src/cli/program/preaction.ts`)
  - Route-first uses the same `ensureConfigReady()` gate before executing the routed handler. (`src/cli/route.ts`)

Gateway bind/auth safety (src/gateway/server-runtime-config.ts):
- Binding to non-loopback without a shared secret is rejected by design.
- Tailscale serve/funnel requires bind=loopback, and funnel requires auth mode=password.
- Gateway runtime config is a merge of config + startGatewayServer overrides:
  - `gateway.auth` is resolved via `resolveGatewayAuth()` (token/password and optional tailscale considerations) and must be configured (`assertGatewayAuthConfigured`).
  - `gateway.tailscale.mode="funnel"` requires `gateway.auth.mode="password"`.
  - `gateway.tailscale.mode!="off"` requires bindHost=loopback.
  - Non-loopback bind requires a shared secret (token or password). (`src/gateway/server-runtime-config.ts`)

Gateway HTTP multiplexer (src/gateway/server-http.ts):
- Request routing order is intentional (first match wins):
  1. Hooks HTTP endpoints (token-gated under configured `hooks.basePath`)
  2. Tools invoke HTTP endpoints (auth-gated; uses `gateway.trustedProxies`)
  3. Slack HTTP ingress
  4. Plugin HTTP handler (extensions can mount handlers)
  5. OpenResponses `POST /v1/responses` (optional)
  6. OpenAI-compatible `POST /v1/chat/completions` (optional)
  7. Canvas host + a2ui endpoints (optional)
  8. Control UI assets + avatar endpoint (optional)
  9. 404 otherwise
- WebSocket upgrades are handled separately: HTTP handler does not touch upgrade requests; `upgrade` is attached in `attachGatewayUpgradeHandler()` and is intercepted by canvas host when applicable.

Gateway boot sequence (src/gateway/server.impl.ts and friends):
- Startup performs *write-on-start* config mutation in two situations:
  - Legacy config migration when legacy keys are detected (non-Nix mode only): `migrateLegacyConfig(snapshot.parsed)` then `writeConfigFile(migrated)`.
  - Plugin auto-enable (`applyPluginAutoEnable`) best-effort persisted to config.
- Control UI root resolution is lazy:
  - `gateway.controlUi.root` is treated as an override and is validated; otherwise it tries to resolve a built-in root and can trigger an on-demand asset build (`ensureControlUiAssetsBuilt`) before re-checking.
- The runtime state is split:
  - `resolveGatewayRuntimeConfig()` computes bind/auth/endpoints/tailscale/hook/canvas flags.
  - `createGatewayRuntimeState()` creates HTTP server(s) and ws server, broadcaster, and chat run registries.
  - `startGatewaySidecars()` starts browser control, gmail watcher, internal hooks, channels, plugin services, and restart sentinel wake.
- Config reload is file-watch based and can hot-reload or restart depending on `gateway.reload.mode` and changed config prefixes. (`src/gateway/config-reload.ts`)

### Change Config Schema or Defaults
Touch points:
- Schema: `src/config/zod-schema*.ts`, `src/config/schema.ts`, `src/config/validation.ts`
- Defaults application: `src/config/defaults.ts`
- IO pipeline: `src/config/io.ts`
- Paths/state: `src/config/paths.ts`
- Legacy migrations and detection: `src/config/legacy*.ts`

Checklist:
1. Decide if this is a schema change, a default change, or a migration.
2. If schema shape changes, update:
   - Zod schema
   - `validateConfigObjectWithPlugins` consumers that assume old keys
   - legacy migrations (`src/config/legacy-migrate.ts` and friends) when needed
3. Confirm config read order invariants remain true:
   - `$include` resolution runs before env substitution
   - `config.env` is applied to `process.env` before `${VAR}` substitution
4. Add/adjust tests under `src/config/*.test.ts`.

### Change Models + Providers
Touch points:
- models.json writer + merge logic: `src/agents/models-config.ts`
- Provider normalization + implicit provider discovery: `src/agents/models-config.providers.ts`
- Auth profiles + env/apiKey helpers: `src/agents/auth-profiles.ts`, `src/agents/model-auth.ts`
- Provider-specific helpers: `src/providers/*`

Core invariants:
- `ensureOpenClawModelsJson()` is the bridge between `openclaw.json` + implicit providers and the agent runtime: if it writes invalid/partial provider config, the embedded runner may fail to start or silently ignore models.
- `normalizeProviders()` is allowed to "fix" common config mistakes (like `${ENV}` vs `ENV`) and to fill missing provider apiKeys from env or auth profiles when models are configured.
- Provider normalization must remain provider-key-stable: changing provider keys, model ids, or auth inference has cross-cutting impacts (model selection, costs/limits, and tool schema compatibility).

Checklist:
1. If you add a provider or new implicit discovery, update `resolveImplicitProviders()`/`ensureOpenClawModelsJson()` and add a focused test.
2. If you change provider auth inference (env var names, auth profile selection, aws-sdk handling), add a regression test that exercises the exact config shape.
3. If you change model id normalization (especially Google/Gemini), check that selection and tool ordering invariants remain valid.

Primary tests:
- `src/agents/models-config.fills-missing-provider-apikey-from-env-var.test.ts`
- `src/agents/models-config.normalizes-gemini-3-ids-preview-google-providers.test.ts`
- `src/agents/models-config.auto-injects-github-copilot-provider-token-is.test.ts`
- `src/providers/github-copilot-token.test.ts`
- `src/providers/qwen-portal-oauth.test.ts`

### Change Memory + Search
Touch points:
- Index/search manager: `src/memory/manager.ts`, `src/memory/search-manager.ts`, `src/memory/manager-search.ts`
- Chunking + file rules: `src/memory/internal.ts`
- Schema + sqlite-vec wiring: `src/memory/memory-schema.ts`, `src/memory/sqlite-vec.ts`, `src/memory/sqlite.ts`
- Config surface: `src/agents/memory-search.ts`
- Memory plugins/backends: `extensions/memory-*`

Core invariants:
- Memory index schema and meta (`memory_index_meta_v1`) must remain coherent with chunking/embedding settings; if you change any meta-relevant fields, you need a migration story (or a forced rebuild).
- Memory indexing is "best effort": failures should not crash the gateway; they should surface as status and recover on the next sync/reindex.
- Session transcript ingestion is incremental and debounced; changing transcript parsing or dirty tracking can cause runaway reindex loops or stale search.

Checklist:
1. If you change chunking/hashing, update vector dedupe expectations and add a test that proves stable results across reindex.
2. If you change embedding provider selection/fallback, ensure timeouts and retry behavior remain bounded.
3. If you change file inclusion rules, check `isMemoryPath()`/extra paths normalization and confirm it doesn't index secrets-by-accident.

Primary tests:
- `src/memory/manager.atomic-reindex.test.ts`
- `src/memory/manager.vector-dedupe.test.ts`
- `src/memory/hybrid.test.ts`
- `src/memory/qmd-manager.test.ts`
- `src/memory/search-manager.test.ts`

#### Extension: Memory-LanceDB
Key files: `extensions/memory-lancedb/index.ts`, `extensions/memory-lancedb/config.ts`

Extension-specific quirks:
- **LanceDB vector backend**: Uses `@lancedb/lancedb` v0.23.0+. Single "memories" table with fixed schema: `id` (UUID v4), `text`, `vector` (dense embedding), `importance` (0-1), `category` (preference/fact/decision/entity/other), `createdAt`. Default storage: `~/.openclaw/memory/lancedb`.
- **OpenAI embeddings only**: Hardcoded to OpenAI provider. Models: `text-embedding-3-small` (1536D, default) or `text-embedding-3-large` (3072D). Single embedding per operation (no batching). Config requires `embedding.apiKey` (supports `${ENV_VAR}` interpolation).
- **Distance metric**: L2 (Euclidean) natively; converted to 0-1 similarity via `1 / (1 + distance)`. No hybrid/keyword search — pure vector only.
- **Duplicate detection**: 0.95 similarity threshold on store prevents near-duplicates. Runs every store operation.
- **Schema initialization**: Bootstrap with dummy `__schema__` row (immediately deleted) to establish table schema. No migration system — schema changes require manual intervention.
- **Auto-capture**: Hooks into `agent_end`. Rule-based triggers (regex patterns for remember/prefer/phone/email/etc.). Filters out system content, markdown-heavy text, emoji-heavy output. Max 3 captures per conversation. Category auto-detected from text content.
- **Auto-recall**: Hooks into `before_agent_start`. Embeds prompt, searches top 3 memories (minScore 0.3), injects as `<relevant-memories>` context block. Failures degrade gracefully.
- **Tools**: `memory_recall` (search, limit 5, minScore 0.1), `memory_store` (save with duplicate check), `memory_forget` (delete by ID or query search). UUID validated before delete to prevent injection.
- **No migrations, no partitioning**: Single table design. All vectors loaded for search. Forward-incompatible with schema changes.

Primary tests:
- `extensions/memory-lancedb/index.test.ts`

#### Extension: Memory-Core
Key files: `extensions/memory-core/index.ts`, `src/memory/manager.ts`, `src/memory/search-manager.ts`, `src/memory/hybrid.ts`, `src/memory/embeddings.ts`, `src/memory/memory-schema.ts`

Extension-specific quirks:
- **Two-tier backend with automatic fallback**: Builtin backend (SQLite in-process) and QMD backend (external `qmd` tool, subprocess). `FallbackMemoryManager` tries QMD first (4s timeout), falls back to builtin on spawn failure or search timeout. Backend selection via `memory.backend` config ("builtin" default, "qmd" opt-in).
- **SQLite + sqlite-vec + FTS5**: Builtin backend uses `node:sqlite` `DatabaseSync` (Node 22.5+). Tables: `files`, `chunks`, `embedding_cache`, `chunks_fts` (FTS5), `chunks_vec` (vector via sqlite-vec). sqlite-vec requires native compilation — falls back to keyword-only search if unavailable. FTS5 may be absent on some SQLite builds; degrades gracefully.
- **Multi-provider embeddings**: Provider "auto" (default) tries: OpenAI → Gemini → local. OpenAI: `text-embedding-3-small` (1536D default) or `text-embedding-3-large`. Gemini: via `GOOGLE_API_KEY`. Local: node-llama-cpp (GGUF model, ~500MB download, requires C++ build tools). Embedding cache: in-memory map + SQLite persistence, keyed by (provider, model, text_hash). Batch mode: concurrency=4, max batch=8000 tokens; disabled after 2 failures.
- **Hybrid search**: Vector cosine similarity (0.7 weight) + BM25 keyword search (0.3 weight). Vector and keyword searches run in parallel, merged sequentially. Default: max 6 results, min score 0.35, max injected chars budget.
- **Chunking**: Line-boundary splitting (not word/sentence). Default 400 tokens, 80-token overlap (carried at line granularity). No semantic awareness — mid-sentence splits possible. Overlap is by whole lines, not rolling window.
- **Memory sources**: `"memory"`: MEMORY.md, memory.md, memory/*.md. `"sessions"`: session transcripts (*.jsonl, experimental, off by default). File watcher debounced at 1.5s. Sync on search (builtin), sync interval 5m, embedding sync interval 60m.
- **MemorySearchManager interface**: Contract for any backend: `search(query, opts?)`, `readFile(params)` (1-indexed line ranges), `status()`, optional `sync()`, `probeEmbeddingAvailability()`, `probeVectorAvailability()`, optional `close()`. Results: `{ path, startLine, endLine, score, snippet, source, citation }`.
- **Citations**: Config `memory.citations`: "auto" (default, on in DMs, off in groups), "on", "off". Format: `path#L{start}-L{end}`.
- **Tools**: `memory_search` (search, limit 5, minScore 0.1), `memory_get` (read file by line range). CLI: `memory status`, `memory index`, `memory search`.
- **QMD backend**: Spawns external `qmd` binary. Collections: memory files + custom paths + optional sessions. Queries via sqlite DB. Scope-gated: only active for direct chats by default.
- **Concurrency**: DatabaseSync is synchronous (blocks on I/O). No explicit locking. Manager instances cached by (agentId, workspaceDir, settings hash). Multiple agents sharing same DB is possible but unsupported.
- **Error resilience**: Search/read failures → partial results or error message. Embedding probe → `{ok, error?}` (doesn't throw). Sync failures → logged, `dirty` flag persists. Batch failures → disables batch mode. Vector ext unavailable → keyword-only.

Primary tests:
- `src/memory/backend-config.test.ts`
- `src/memory/embeddings.test.ts`
- `src/memory/hybrid.test.ts`
- `src/memory/index.test.ts`
- `src/memory/internal.test.ts`
- `src/memory/manager.async-search.test.ts`
- `src/memory/manager.atomic-reindex.test.ts`
- `src/memory/manager.batch.test.ts`
- `src/memory/manager.embedding-batches.test.ts`
- `src/memory/manager.sync-errors-do-not-crash.test.ts`
- `src/memory/manager.vector-dedupe.test.ts`
- `src/memory/qmd-manager.test.ts`
- `src/memory/search-manager.test.ts`
- `src/agents/memory-search.test.ts`
- `src/agents/tools/memory-tool.citations.test.ts`
- `src/agents/tools/memory-tool.does-not-crash-on-errors.test.ts`
- `src/cli/memory-cli.test.ts`

### Change Security + Audit
Touch points:
- Security audit/fix: `src/security/audit.ts`, `src/security/fix.ts`, `src/security/external-content.ts`
- Gateway connect/auth policy: `src/gateway/auth.ts`, `src/gateway/device-auth.ts`, `src/gateway/origin-check.ts`
- High-risk execution boundaries: `src/infra/exec-approvals.ts`, `src/agents/tool-policy.ts`, `src/infra/net/*`

Core invariants:
- Auth boundaries must remain "default secure": connect, pair, and operator-only methods should never become callable by untrusted roles.
- Audit output is operator-facing and should remain actionable: add checks sparingly, keep remediations concrete, and never emit secrets in findings.
- Any feature that fetches remote content or executes host commands must flow through SSRF + sandbox + approvals seams; security fixes often require updating multiple seams at once.

Checklist:
1. If you change gateway auth behavior, run the auth/origin tests and validate that role/method allowlists remain unchanged unless intentional.
2. If you add a new audit check, ensure it is deterministic and does not require network access unless `--deep` (or equivalent) is explicitly requested.
3. If you change redaction or log formatting, verify audit reports remain paste-safe for issue reports.

Primary tests:
- `src/security/audit.test.ts`
- `src/security/fix.test.ts`
- `src/security/external-content.test.ts`
- `src/gateway/auth.test.ts`
- `src/gateway/origin-check.test.ts`

### Change CLI Boot + Routing
Touch points:
- Entry + respawn: `src/entry.ts`
- Main CLI: `src/cli/run-main.ts`
- Route-first fast path: `src/cli/route.ts`, `src/cli/program/command-registry.ts`
- Lazy subcommands: `src/cli/program/register.subclis.ts`
- Config guard + preAction behavior: `src/cli/program/config-guard.ts`, `src/cli/program/preaction.ts`

Core invariants:
- The CLI may respawn to apply Node warning suppression; argv/env mutations must remain correct across respawn boundaries.
- Route-first intentionally runs some commands without fully building Commander; new flags/commands must not get half-parsed.
- Lazy subcommands re-run parsing after dynamic import; registration timing affects plugin CLI integration.
- The config readiness gate is a safety boundary: most commands must not run with invalid config.

Checklist:
1. If you add a new top-level command, decide if it belongs in route-first; if so, update the route registry and tests.
2. If you change early env/profile parsing, verify behavior across direct invocations (`openclaw ...`) and node/bun entrypoints.
3. If you change the config guard allowlist, verify which commands can run under invalid config and why.

Primary tests:
- `src/cli/run-main.test.ts`
- `src/cli/program.smoke.test.ts`
- `src/cli/program/register.subclis.test.ts`
- `src/cli/argv.test.ts`

### Change Gateway Boot (Runtime Wiring)
Touch points:
- Boot orchestrator: `src/gateway/server.impl.ts`
- Runtime config resolution + bind/auth safety: `src/gateway/server-runtime-config.ts`
- HTTP mux routing: `src/gateway/server-http.ts`
- Sidecars/service startup: `src/gateway/server-startup.ts`
- Hot reload vs restart: `src/gateway/config-reload.ts`, `src/gateway/server-reload-handlers.ts`

Core invariants:
- Startup may mutate config on disk (legacy migration and plugin auto-enable); this must remain safe and bounded.
- HTTP routing order is intentional; adding endpoints can shadow others if inserted in the wrong place.
- Non-loopback binds are rejected unless auth is configured; tailscale serve/funnel has additional constraints.
- Reload mode determines whether changes hot-apply or require restart; plugin reload prefix contributions are part of the contract.

Checklist:
1. If you add an HTTP endpoint, verify `createGatewayHttpServer()` routing order and whether WS upgrades are affected.
2. If you add a sidecar/service, ensure it has symmetric start/stop wiring and participates in reload (hot or restart) as appropriate.
3. If you change bind/auth rules, update both runtime enforcement and operator-facing hints.

Primary tests:
- `src/gateway/boot.test.ts`
- `src/gateway/config-reload.test.ts`
- `src/gateway/gateway.e2e.test.ts`
- `src/gateway/server.health.e2e.test.ts`

### Change Hooks (Ingress + Transforms)
Touch points:
- Hooks config + token extraction + payload validation: `src/gateway/hooks.ts`
- Hook mapping presets + transforms dir resolution: `src/gateway/hooks-mapping.ts`
- HTTP wiring: `src/gateway/server-http.ts`, `src/gateway/server/hooks.ts`
- Hook implementations + installers: `src/hooks/*`

Core invariants:
- `hooks.enabled=true` requires `hooks.token`, and `hooks.path` may not be `/`. (`src/gateway/hooks.ts`)
- Hook auth is token-based; the accepted token sources (Authorization bearer, `x-openclaw-token`, query param) are part of the contract. (`src/gateway/hooks.ts`)
- Hook-driven agent turns are executed via the cron isolated-agent path; they must remain lane-isolated and must not bypass normal safety gates. (`src/gateway/server/hooks.ts`, `src/cron/isolated-agent.ts`)

Checklist:
1. If you change token parsing or routing, run hooks e2e tests and confirm query-token warnings and header precedence remain intact.
2. If you add a new mapping preset or transform, update both the mapping resolver and the operator docs for the payload shape.
3. If you change max body limits, ensure oversized payloads fail fast without buffering the entire request.

Primary tests:
- `src/gateway/hooks.test.ts`
- `src/gateway/hooks-mapping.test.ts`
- `src/gateway/server.hooks.e2e.test.ts`
- `src/hooks/loader.test.ts`

### Change Cron (Scheduling + Isolated Agent Runs)
Touch points:
- Cron service: `src/cron/service.ts`, `src/cron/service/*`
- Isolated agent execution: `src/cron/isolated-agent.ts`
- Gateway wiring + RPC methods: `src/gateway/server-cron.ts`, `src/gateway/server-methods/cron.ts`
- Lanes/concurrency: `src/gateway/server-lanes.ts`

Core invariants:
- Cron runs use a dedicated command lane (`cron`) with explicit concurrency control; do not accidentally run cron jobs on the main lane.
- Cron service must be timer-idempotent (avoid duplicate timers) and must persist job state safely between restarts. (see `src/cron/service.prevents-duplicate-timers.test.ts`, `src/cron/service.store.migration.test.ts`)
- Delivery behavior (announce vs direct) is part of the contract; changes must be validated against the isolated-agent delivery tests.

Checklist:
1. If you change schedule parsing/normalization, update conformance tests and ensure nextRun state remains stable.
2. If you change isolated-agent delivery, verify it cannot silently send to the wrong channel/recipient.
3. If you touch cron storage, add a migration test that proves older stores still load.

Primary tests:
- `src/cron/cron-protocol-conformance.test.ts`
- `src/cron/schedule.test.ts`
- `src/cron/service.prevents-duplicate-timers.test.ts`
- `src/cron/isolated-agent.*.test.ts`

### Change Gateway Protocol + Schemas
Touch points:
- Protocol schemas: `src/gateway/protocol/schema/*`, re-export `src/gateway/protocol/schema.ts`
- Runtime validation: `src/gateway/protocol/index.ts` (AJV compilers)
- Connect handshake + version negotiation: `src/gateway/server/ws-connection/*`
- Method advertising: `src/gateway/server-methods-list.ts`
- Authorization allowlists: `src/gateway/server-methods.ts`

Core invariants:
- Protocol negotiation uses `minProtocol/maxProtocol` vs `PROTOCOL_VERSION`; breaking changes require a deliberate version bump and compat story.
- Method/event advertisement is a separate contract from implementation; "implemented but not advertised" is intentional in a few cases.
- Authorization is allowlist-based; adding a method must include scopes and READ/WRITE classification (or be intentionally admin-only/hidden).

Checklist:
1. If you change a request/response shape, update the TypeBox schema and AJV validator export.
2. If you add/remove a method/event, update the advertised lists unless intentionally hidden.
3. If you introduce a schema coverage gap (manual validation), document it and add tests that protect the runtime checks.

Primary tests:
- `src/gateway/protocol/index.test.ts`
- `src/gateway/auth.test.ts`
- `src/gateway/server-methods/agent.test.ts`
- `src/gateway/server-methods/send.test.ts`

### Add a New Gateway WS Method or Event
Touch points:
- Implementation: `src/gateway/server-methods/*.ts`
- Method list advertising: `src/gateway/server-methods-list.ts`
- Protocol schema/types: `src/gateway/protocol/schema/*`
- WS request handling: `src/gateway/server/ws-connection/*` (usually unchanged)

Core invariants:
- Authorization scope classification is mandatory: every method must be in READ_METHODS, WRITE_METHODS, APPROVAL_METHODS, PAIRING_METHODS, or match ADMIN_METHOD_PREFIXES. Missing classification defaults to requiring `operator.admin`. (`src/gateway/server-methods.ts`)
- READ scope includes WRITE (a WRITE-scoped client can call READ methods); scope hierarchy is part of the contract.
- Method/event advertisement via `BASE_METHODS`/`GATEWAY_EVENTS` in `src/gateway/server-methods-list.ts` is a separate contract from implementation; plugin methods extend via `listGatewayMethods()`.
- Protocol schemas require TypeBox definitions exported via `ProtocolSchemas`; AJV validators are compiled at import time. (`src/gateway/protocol/index.ts`)

Checklist:
1. Add handler + auth scopes.
2. Add schema and export it via `src/gateway/protocol/schema.ts` and `ProtocolSchemas`.
3. Add to advertised methods/events lists (unless intentionally hidden).
4. Add e2e coverage under `src/gateway/server.*.e2e.test.ts` when contract matters.

Primary tests:
- `src/gateway/server.auth.e2e.test.ts`
- `src/gateway/server.roles-allowlist-update.e2e.test.ts`
- `src/gateway/server.health.e2e.test.ts`

### Change WebSocket Connect/Auth/Pairing
Touch points:
- Handshake: `src/gateway/server/ws-connection.ts` + `src/gateway/server/ws-connection/message-handler.ts`
- Auth: `src/gateway/auth.ts`, `src/gateway/server-runtime-config.ts`
- Device pairing: `src/infra/device-identity.ts`, `src/infra/device-pairing.ts`, `src/infra/device-auth-store.ts`
- Node pairing: `src/infra/node-pairing.ts`

Core invariants:
- Protocol negotiation uses `minProtocol/maxProtocol` vs `PROTOCOL_VERSION`; version mismatch is checked before device auth. Breaking changes require a version bump. (`src/gateway/server/ws-connection/message-handler.ts`)
- Device signature verification uses Ed25519; nonce must be within `DEVICE_SIGNATURE_SKEW_MS` (10 minutes, checked in `src/gateway/server/ws-connection/message-handler.ts`). Device ID is derived from public key fingerprint via SHA256. (`src/infra/device-identity.ts`)
- Pending pairing requests have a 5-minute TTL (`PENDING_TTL_MS`). Approved devices are persisted in `<stateDir>/devices/paired.json`. (`src/infra/device-pairing.ts`)
- Local vs. proxied detection uses `isLoopbackAddress()` and respects `gateway.trustedProxies` for `X-Forwarded-For` parsing. (`src/gateway/auth.ts`)

Checklist:
1. Preserve local-vs-proxied detection invariants (`gateway.trustedProxies`).
2. Preserve protocol negotiation (`minProtocol/maxProtocol` vs `PROTOCOL_VERSION`).
3. Preserve device signature verification and nonce binding rules.
4. Update pairing/token cache semantics only with explicit migration story.

Primary tests:
- `src/gateway/server.auth.e2e.test.ts`
- `src/infra/device-pairing.test.ts`

### Change Nodes (Device Boundary)
Touch points:
- Gateway node registry + RPC handlers: `src/gateway/node-registry.ts`, `src/gateway/server-methods/nodes.ts`
- Node connect/disconnect wiring: `src/gateway/server/ws-connection.ts`, `src/gateway/server/ws-connection/message-handler.ts`
- Node command policy (allowlist + config): `src/gateway/node-command-policy.ts`
- Node subscriptions and node-originated events: `src/gateway/server-node-subscriptions.ts`, `src/gateway/server-node-events.ts`
- Protocol schemas: `src/gateway/protocol/schema/nodes.ts` (+ exports/registry under `src/gateway/protocol/schema/*`)
- Node host (desktop/headless node): `src/node-host/config.ts`, `src/node-host/runner.ts`
- Companion apps (wire contract surfaces):
  - Shared: `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift`
  - iOS: `apps/ios/Sources/Model/NodeAppModel.swift`
  - Android: `apps/android/app/src/main/java/ai/openclaw/android/gateway/GatewaySession.kt`, `apps/android/app/src/main/java/ai/openclaw/android/NodeRuntime.kt`
  - macOS: `apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift`, `apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift`

Core invariants:
- Role gating is strict:
  - role=node is only allowed to call `node.invoke.result`, `node.event`, and `skills.bins`. (`src/gateway/server-methods.ts`)
  - Operators cannot call node-only methods; nodes cannot call operator methods.
- `nodeId` used by Gateway APIs is the *device identity id* (`connect.device.id`), not the client `instanceId`.
  - The server registers `NodeSession.nodeId` from `connect.device.id` when present. (`src/gateway/node-registry.ts`)
  - On connect, the server updates pairing metadata for both `nodeSession.nodeId` and `connect.client.instanceId` (when provided) to preserve historical pairing keys. (`src/gateway/server/ws-connection/message-handler.ts`)
- `node.invoke` is gated twice:
  1. the command must be allowlisted for the node's platform/device family (`resolveNodeCommandAllowlist`, plus config overrides `gateway.nodes.allowCommands` / `gateway.nodes.denyCommands`)
  2. the node must have declared the command in its `connect.commands` list
  If `connect.commands` is missing/empty, *no node commands are allowed*. (`src/gateway/node-command-policy.ts`, `src/gateway/server-methods/nodes.ts`)
- Invokes are delivered as a node event `node.invoke.request` with payload `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }`. (`src/gateway/node-registry.ts`, `src/gateway/protocol/schema/nodes.ts`)
- Invoke result handling is intentionally forgiving:
  - Results must echo `id` and `nodeId`; nodeId mismatches are rejected.
  - Late/unknown invoke results return `{ ok: true, ignored: true }` to reduce log noise. (`src/gateway/server-methods/nodes.ts`, `src/gateway/server.nodes.late-invoke.test.ts`)
- Node event ingestion (`node.event`) prefers `payloadJSON`; when only `payload` is provided it is JSON-stringified.
  The gateway only handles a narrow set of node-originated events:
  - `voice.transcript` and `agent.request` (run agent in a session, deliver=false by default)
  - `chat.subscribe` / `chat.unsubscribe` (manage node session subscriptions)
  - `exec.started` / `exec.finished` / `exec.denied` (enqueue system events + request heartbeat)
  Unknown events are ignored. (`src/gateway/server-node-events.ts`)
- Node chat subscriptions are sessionKey-based and are cleared on node disconnect. (`src/gateway/server-node-subscriptions.ts`, `src/gateway/server/ws-connection.ts`)

Checklist (when adding/changing a node command or node event):
1. Decide which platform(s) implement it (macOS/iOS/Android/node-host) and ensure the node declares it in `connect.commands`.
2. Update platform defaults in `src/gateway/node-command-policy.ts` and/or document why it is not allowlisted by default.
3. Update protocol schemas (`src/gateway/protocol/schema/nodes.ts`) if params/results/events change shape.
4. Ensure the gateway handler path is correct:
   - operator -> `node.invoke` -> `node.invoke.request` event -> node -> `node.invoke.result`
   - node -> `node.event` -> `handleNodeEvent`
5. Add/adjust tests:
   - allowlist/declared command gating (unit tests near node command policy or node handlers)
   - invoke timeout/late result semantics (`src/gateway/server.nodes.late-invoke.test.ts`)
   - node event ingestion (`src/gateway/server-node-events.test.ts`)

### Change Media Pipeline
Touch points:
- MEDIA token parsing and safety: `src/media/parse.ts` + `src/media/parse.test.ts`
- Remote fetch + MIME detection: `src/media/fetch.ts`, `src/media/mime.ts`
- Temporary storage + hosting: `src/media/store.ts`, `src/media/server.ts`, `src/media/host.ts`
- Image normalization/optimization: `src/media/image-ops.ts`, plus web ingestion `src/web/media.ts`
- Input file extraction (PDF/text/images) for HTTP endpoints: `src/media/input-files.ts`
- Media understanding (vision/audio/video pre-processing): `src/media-understanding/*` (especially `apply.ts`, `attachments.ts`, `runner.ts`, `scope.ts`, `format.ts`)

Core invariants:
- MEDIA token extraction is security-sensitive:
  - Only `http(s)://...` URLs and safe relative paths starting with `./` are treated as media.
  - Absolute paths, `~` paths, and any `..` traversal are rejected to prevent LFI.
  - Tokens inside fenced code blocks are ignored.
  - `[[audio_as_voice]]` is a separate tag that is detected and stripped. (`src/media/parse.ts`)
- Temporary media hosting is intentionally ephemeral:
  - Saved media defaults to a 5MB cap and a 2-minute TTL.
  - The media server serves `GET /media/:id`, blocks traversal and symlink escape, checks TTL/size, and deletes the file after response (best-effort) plus periodic cleanup. (`src/media/store.ts`, `src/media/server.ts`)
  - `ensureMediaHosted()` returns a tailnet URL and requires the webhook/Funnel server (or `--serve-media` to start a temp server). (`src/media/host.ts`)
- Remote fetch is guarded:
  - `fetchRemoteMedia()` uses the shared SSRF guard and enforces `maxBytes` during streaming reads.
  - Filenames may come from `Content-Disposition`; MIME is derived via sniff + extension/header heuristics. (`src/media/fetch.ts`, `src/media/mime.ts`)
- Web media ingestion clamps and (optionally) optimizes images:
  - Default per-kind caps: images 6MB, audio/video 16MB, documents 100MB.
  - HEIC/HEIF can be converted; images may be resized/compressed; PNG alpha preservation uses a PNG-first path and only falls back to JPEG when needed. (`src/web/media.ts`, `src/media/image-ops.ts`, `src/media/constants.ts`)
- Media understanding (pre-processing) is part of inbound message normalization:
  - `applyMediaUnderstanding()` can produce `[Image]`/`[Audio]`/`[Video]` transcript/description sections injected into `ctx.Body`.
  - If audio is transcribed, it sets `ctx.Transcript` and adjusts `ctx.CommandBody`/`ctx.RawBody` so downstream command parsing uses the transcript (or original user text when present). (`src/media-understanding/apply.ts`)
  - It can also extract text from attached files and append `<file name="..." mime="...">...</file>` blocks with XML-escaping to prevent prompt injection via tags. (`src/media-understanding/apply.ts`, `src/media/input-files.ts`)
  - Scope rules can disable media understanding by sessionKey prefix, channel, and chatType. (`src/media-understanding/scope.ts`)
  - Image understanding is skipped when the active model supports vision natively (image is expected to be injected directly into model context instead). (`src/media-understanding/runner.ts`)
  - Provider HTTP calls are SSRF-guarded; when a provider `baseUrl` is explicitly configured, private-network access is allowed for that request (intended for self-hosted endpoints). (`src/media-understanding/providers/shared.ts`)
  - Provider config composition is non-trivial:
    - model entries come from capability-local `tools.media.<capability>.models` plus shared `tools.media.models`; when none are configured, some capabilities can auto-select providers based on available API keys and default models (see `DEFAULT_*_MODELS`). (`src/media-understanding/resolve.ts`, `src/media-understanding/runner.ts`)
    - for audio providers, `baseUrl` resolves as `entry.baseUrl ?? capabilityConfig.baseUrl ?? cfg.models.providers[provider].baseUrl`, and headers merge in the order provider config -> capability config -> entry. (`src/media-understanding/runner.ts`)
    - Deepgram `providerOptions` keys are normalized to the API's snake_case, and `tools.media.audio.deepgram.*` flags are merged as compat defaults when the query is missing keys. (`src/media-understanding/runner.ts`)

Link understanding (`src/link-understanding/`):
- `applyLinkUnderstanding()` is called during inbound message processing (from `auto-reply/reply/get-reply.ts`). It extracts URLs, runs configured CLI models per-URL, and mutates `ctx.LinkUnderstanding` + `ctx.Body`.
- URL extraction: bare `http(s)://` URLs only; excludes 127.0.0.1; strips markdown links first; max links configurable (default 3). (`src/link-understanding/detect.ts`)
- Scope policy reuses `resolveMediaUnderstandingScope()` from media-understanding; deny -> skips entirely.
- CLI model execution uses `runExec()` from `src/process/exec.ts` with `CLI_OUTPUT_MAX_BUFFER`; timeout per-entry or global (default 30s). Template vars: `LinkUrl`, `MsgContext`.
- Body injection calls `finalizeInboundContext()` with `forceBodyForAgent=true`.

Checklist (when changing media behavior or limits):
1. Decide whether this is:
   - MEDIA token parsing/output behavior (model output -> attachment delivery), or
   - media hosting/storage/serving, or
   - inbound attachment ingestion + media understanding.
2. Preserve security boundaries:
   - keep SSRF guard coverage for remote fetch
   - keep LFI protections for local paths and media server routes
3. If you change caps/limits, update:
   - constants and default limits (`src/media/constants.ts`, `src/media/input-files.ts`, `src/media/store.ts`)
   - tests (`src/media/*.test.ts`, `src/media-understanding/*.test.ts`)
4. If you change how understanding modifies inbound context, validate downstream invariants:
   - command parsing uses `ctx.CommandBody`/`ctx.RawBody`
   - session routing and delivery surfaces still see the correct `ctx.Body`
5. If you change link understanding scope, verify it stays in sync with media-understanding scope rules (shared `resolveMediaUnderstandingScope`).
6. If you change link URL extraction, verify 127.0.0.1 exclusion, markdown link stripping, and max-links cap.

Primary tests:
- `src/media/parse.test.ts`
- `src/media/fetch.test.ts`
- `src/media-understanding/apply.test.ts`
- `src/media-understanding/scope.test.ts`
- `src/link-understanding/detect.test.ts`

### Change Sessions + Transcripts
Touch points:
- Session persistence and hygiene: `src/agents/session-write-lock.ts`, `src/agents/session-file-repair.ts`, `src/agents/session-transcript-repair.ts`
- Tool call/result persistence guard: `src/agents/session-tool-result-guard.ts`, `src/agents/session-tool-result-guard-wrapper.ts`
- Session key helpers and send policy: `src/sessions/*`, `src/routing/session-key.ts`, `src/routing/resolve-route.ts`

Core invariants:
- Session files are JSONL and must remain repairable; avoid partial writes and maintain stable headers.
- Tool call/result pairing is enforced at persistence time (missing tool results are synthesized); providers with strict turn order depend on this.
- Cross-process safety: session writers use a lock file; concurrent writers must not corrupt JSONL.

Checklist:
1. If you add a new tool or change tool streaming shape, validate transcript repair and tool-result synthesis still keep the transcript provider-valid.
2. If you change session file layout, ensure repair still detects a valid header and can safely rewrite the file.
3. If you change sessionKey composition/routing, validate any logic that derives delivery context, mirrors transcripts, or selects per-session policies from sessionKey tokens.

Primary tests:
- `src/agents/session-write-lock.test.ts`
- `src/agents/session-file-repair.test.ts`
- `src/agents/session-transcript-repair.test.ts`
- `src/agents/session-tool-result-guard.test.ts`
- `src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts`

### Change Auto-reply Pipeline
Touch points:
- Core pipeline: `src/auto-reply/dispatch.ts`, `src/auto-reply/envelope.ts`, `src/auto-reply/heartbeat.ts`, `src/auto-reply/templating.ts`
- Commands + directives: `src/auto-reply/reply/commands-*.ts`, directive plumbing under `src/auto-reply/reply/*directive*`
- Mention gating + activation + authorization: `src/auto-reply/group-activation.ts`, `src/auto-reply/command-auth.ts`, `src/channels/mention-gating.ts`, `src/channels/command-gating.ts`

Core invariants:
- Group safety is multi-layered: mention gating, activation, and command authorization are separate checks; regressions often come from changing only one.
- Plugin commands are matched before built-ins; reserved-name and auth-default rules are part of the seam contract.
- Delivery behavior is sensitive to sessionKey selection and outbound policy; regressions show up as silent drops or misrouted replies.

Checklist:
1. If you add a command or directive, update parsing, auth, and help surfaces, and add a test that covers the exact chatType + mention/activation scenario.
2. If you change mention/activation defaults, verify across multiple channels (core + extension channels) because docks can override gating behavior.

Primary tests:
- `src/auto-reply/commands-registry.test.ts`
- `src/auto-reply/reply/commands*.test.ts`
- `src/channels/mention-gating.test.ts`
- `src/channels/command-gating.test.ts`

### Change Tools + Sandbox
Touch points:
- Tool list construction + policy layering: `src/agents/pi-tools.ts`, `src/agents/pi-tools.policy.ts`, `src/agents/tool-policy.ts`
- Schema normalization for provider quirks: `src/agents/pi-tools.schema.ts`, `src/agents/schema/clean-for-gemini.ts`
- Sandbox runtime + browser: `src/agents/sandbox/*`
- Network boundaries: `src/infra/net/ssrf.ts`, `src/infra/net/fetch-guard.ts`

Core invariants:
- Tool allow/deny is layered (global, per-provider, per-agent, group policy, sandbox policy, subagent policy); deny wins.
- Providers reject certain schema shapes; avoid introducing top-level unions or incompatible JSON Schema keywords in tool schemas.
- SSRF guard must be used for any HTTP fetch outside explicitly trusted surfaces; private-network access is a deliberate opt-in (for explicit baseUrl configurations).
- Sandbox container identity is hash-based; do not casually change hash inputs without a migration story for running containers.

Checklist:
1. If you add a new tool, ensure it participates in policy resolution (including group and sandbox) and has provider-safe schema.
2. If the tool can touch network or filesystem, confirm SSRF and sandbox boundaries are enforced and covered by tests.
3. If you adjust tool groups or profiles, ensure you do not silently revoke core tools when users only add plugin tools (`alsoAllow` vs `allow` semantics).

Primary tests:
- `src/agents/tool-policy.test.ts`
- `src/agents/tool-policy.conformance.test.ts`
- `src/agents/pi-tools.policy.test.ts`
- `src/agents/sandbox/tool-policy.test.ts`
- `src/infra/net/ssrf.pinning.test.ts`

### Change Exec Approvals
Touch points:
- Shared model: `src/infra/exec-approvals.ts`
- Gateway wiring: `src/gateway/exec-approval-manager.ts`
- Forwarding: `src/infra/exec-approval-forwarder.ts` and node exec.* events

Core invariants:
- Approvals are a safety boundary; keep enforcement strict and avoid leaking sensitive details into logs/transcripts.
- Forwarding must preserve correlation (approval id and metadata) and must not drop terminal events (started/finished/denied).

Checklist:
1. If you change approval lifecycle (pending/approved/denied/expired), confirm idempotency: duplicate decisions and late results must be ignored safely.
2. If you change forwarding targets (session last-route, configured overrides), confirm correlation is preserved end-to-end and delivery remains best-effort.
3. If you change any text output emitted to users/logs, re-check redaction and ensure sensitive command details are not leaked by default.

Primary tests:
- `src/infra/exec-approvals.test.ts`
- `src/infra/exec-approval-forwarder.test.ts`

### Change Plugins + Extensions
Touch points:
- Discovery + loading: `src/plugins/discovery.ts`, `src/plugins/loader.ts`, `src/plugins/manifest*.ts`
- Registry contract: `src/plugins/registry.ts`, `src/plugins/types.ts`, `src/plugins/hooks.ts`, `src/plugins/services.ts`
- Plugin tools + optional tools: `src/plugins/tools.ts`
- Plugin install/update switching: `src/plugins/install.ts`, `src/plugins/update.ts`
- SDK aliasing: `src/plugin-sdk/*`

Core invariants:
- Plugin precedence is deterministic: config-specified > workspace > global state dir > bundled; duplicate ids are recorded as disabled.
- Plugin registration must be synchronous; async `register()` results are ignored (warned) by design.
- Gateway method names and HTTP routes must remain globally unique across core and plugins; overrides are forbidden.

Checklist:
1. When adding a new plugin surface (tools/hooks/methods/routes), ensure it is wired through the registry and used by both core and extension channels where relevant.
2. When changing plugin enablement or slots, verify config semantics (enabled/deny/allow) and update-channel switching logic (bundled vs npm).
3. When touching the SDK alias, ensure dev and dist builds both resolve `openclaw/plugin-sdk` consistently.

Primary tests:
- `src/plugins/discovery.test.ts`
- `src/plugins/loader.test.ts`
- `src/plugins/install.test.ts`
- `src/plugins/slots.test.ts`
- `src/plugins/config-state.test.ts`
- `src/gateway/server-plugins.test.ts`

### Change Channels + Delivery
Touch points:
- Shared channel contracts: `src/channels/*`, `src/channels/plugins/types.*.ts`, `src/channels/dock.ts`
- Outbound delivery + mirroring: `src/infra/outbound/*`
- Per-channel providers (examples): `src/web/*`, plus extension channels under `extensions/*`

Core invariants:
- Channel behavior is intentionally normalized through docks/adapters; avoid hardcoding per-channel special cases outside the dock layer unless unavoidable.
- Delivery is multi-step: target resolution, outbound sessionKey composition, adapter chunking/media limits, then optional mirroring into transcripts.
- Status schemas are permissive in places to allow plugin channels to add fields without breaking protocol validation.

Checklist:
1. If you change allowlist/mention gating/tool policy behavior, validate across all channels (core + extensions) because each dock can override semantics.
2. If you change outbound target resolution, ensure implicit targets from session context still resolve correctly and directory cache invalidation is preserved.
3. If you change media limits or chunking, ensure adapter-specific rules and fallbacks (text-only when media fails) remain correct.

Primary tests:
- `src/channels/registry.test.ts`
- `src/channels/channel-config.test.ts`
- `src/channels/targets.test.ts`
- `src/channels/plugins/load.test.ts`
- `src/infra/outbound/deliver.test.ts`
- `src/infra/outbound/target-resolver.test.ts`
- `src/infra/outbound/outbound-policy.test.ts`

#### Provider: WhatsApp/Web
Key files: `src/web/session.ts`, `src/web/auth-store.ts`, `src/web/login-qr.ts`, `src/web/accounts.ts`, `src/web/monitor/`, `extensions/whatsapp/src/channel.ts`

Provider-specific quirks:
- **Baileys socket**: Uses `@whiskeysockets/baileys` for WhatsApp Web protocol. Connection is QR-code linked-device pairing (not password auth). Credentials stored in `<stateDir>/oauth/whatsapp/{accountId}/creds.json` with `.bak` backup on every write.
- **QR login state machine**: `startWebLoginWithQr()` generates QR as base64 PNG (3-min TTL); `waitForWebLogin()` polls with 120s deadline. Error 515 = WhatsApp internal restart; handled with automatic socket restart. `DisconnectReason.loggedOut` clears creds and prompts re-scan.
- **Self-identity caching**: JID (`{phone}@s.whatsapp.net`) cached in `creds.json` under `me.id` for status reporting without connecting.
- **Reconnection**: Exponential backoff (initial 2s, max 30s, factor 1.8, jitter 0.25, max 12 attempts). Watchdog timer forces reconnect after 30 min without messages.
- **Media**: Default 5 MB cap (`DEFAULT_WEB_MEDIA_BYTES`). HEIC/HEIF auto-converted to JPEG. Outbound optimization: grid search over resolutions (2048→800) and qualities (80→40) to fit cap. PNG alpha preservation uses PNG-first path.
- **Group roster**: On-demand via `groupMetadata(jid)` with 5-min cache. JID-to-E164 resolution with LID (Linked Device ID) fallback.
- **Message dedup**: Per `${accountId}:${remoteJid}:${messageId}`. History messages (`type="append"`) marked read but never trigger auto-reply.
- **Polls**: Max 12 options, single/multiple choice support via Baileys native poll message.
- **Read receipts**: Default enabled; explicitly disabled in self-chat mode.
- **Ack reactions**: Configurable emoji + scope (direct/group-mentions/group-always), sent in background before reply.
- **DM policy default**: `"pairing"` — unknown senders get automatic pairing-request reply with grace period for historical messages.

Primary tests:
- `src/web/session.test.ts`
- `src/web/login.test.ts`
- `src/web/login-qr.test.ts`
- `src/web/media.test.ts`
- `src/web/outbound.test.ts`
- `src/web/inbound.test.ts`
- `src/web/accounts.test.ts`
- `src/web/auto-reply.web-auto-reply.requires-mention-group-chats-injects-history-replying.test.ts`
- `src/web/auto-reply/monitor/group-gating.test.ts`

#### Provider: Telegram
Key files: `src/telegram/bot.ts`, `src/telegram/monitor.ts`, `src/telegram/send.ts`, `src/telegram/accounts.ts`, `src/telegram/bot-handlers.ts`, `src/telegram/bot-updates.ts`, `extensions/telegram/src/channel.ts`

Provider-specific quirks:
- **Grammy framework**: Uses `grammy` bot library with `@grammyjs/transformer-throttler` for automatic API rate limiting.
- **Token resolution**: Account-specific `tokenFile` → account `botToken` → default `tokenFile` → default `botToken` → `TELEGRAM_BOT_TOKEN` env var.
- **Update dedup**: 5-min TTL, max 2000 entries. Keys: `update_id` (primary), callback query ID (inline buttons), `message:chatId:messageId` (fallback).
- **Media group buffering**: 500ms timeout collects multi-photo/video sends into single context. Text fragment coalescing: 4000 char threshold + 1500ms gap + max 12 parts + 50k total.
- **Captions**: 1024 char limit. Overflow → send media without caption + follow-up text message.
- **Sticker cache**: Persistent (`<stateDir>/telegram/sticker-cache.json`), keyed by `file_unique_id`. Vision-based description (OpenAI/Anthropic/Google). Only static WEBP supported; animated TGS and video WEBM stickers skipped.
- **Forum/topic support**: `is_forum=true` uses `message_thread_id` for separate sessions per topic. General topic (ID=1) must omit `message_thread_id` in API calls (Telegram rejects it).
- **Inline buttons**: Scoped by chat type (off/dm/group/all/allowlist). callback_data limited to 64 bytes. Callback query dedup: TTL 5 min, max 2000 entries.
- **Reaction levels**: off/ack/minimal/extensive. Ack sends eye emoji while processing.
- **Voice message privacy**: Users can block voice messages (Premium feature). Error `VOICE_MESSAGES_FORBIDDEN` → fallback to text. Only OGG Opus supported for voice.
- **HTML formatting**: Sends with `parse_mode: "HTML"`. On parse failure (malformed entities), resends as plain text.
- **Draft streaming**: Max 4096 chars (Telegram limit), 300ms default throttle for edit-in-place.
- **Network recovery**: Exponential backoff (2-30s, factor 1.8, jitter 0.25, max 5 min window). HTTP 409 (concurrent polling sessions) handled gracefully.
- **Proxy support**: Custom fetch via HTTP proxy configuration.
- **Default media cap**: 5 MB.

Primary tests:
- `src/telegram/bot.test.ts`
- `src/telegram/monitor.test.ts`
- `src/telegram/send.caption-split.test.ts`
- `src/telegram/format.test.ts`
- `src/telegram/sticker-cache.test.ts`
- `src/telegram/voice.test.ts`
- `src/telegram/inline-buttons.test.ts`
- `src/telegram/reaction-level.test.ts`
- `src/telegram/bot-native-commands.test.ts`
- `src/telegram/bot/delivery.test.ts`
- `src/telegram/network-errors.test.ts`

#### Provider: Discord
Key files: `src/discord/monitor/provider.ts`, `src/discord/monitor/listeners.ts`, `src/discord/monitor/message-handler.*.ts`, `src/discord/send.*.ts`, `src/discord/api.ts`, `extensions/discord/src/channel.ts`

Provider-specific quirks:
- **Gateway + REST hybrid**: Real-time events via WebSocket (`@buape/carbon` with `GatewayPlugin`); sends/reads via REST. Required intents: Guilds, GuildMessages, MessageContent, DirectMessages, GuildMessageReactions, DirectMessageReactions. Optional: GuildPresences, GuildMembers.
- **Retry policy**: 3 attempts, exponential backoff 500ms-30s, rate-limit aware (429 handling).
- **Guild permissions**: Role-based with channel overwrites (allow/deny bits). Calculation: @everyone role → role additions → channel overrides. Bot needs explicit perms (ViewChannel, SendMessages, etc.); admin flag alone doesn't bypass denying overwrites.
- **Thread model**: Auto-thread creation on replies (configurable per channel). Thread names sanitized (100 char UTF-16 limit), auto-archive 60 min default. Thread starter cache: 5-min TTL, 30-sec negative cache.
- **Text chunking**: 2000 char + 17 line soft limit per message. Smart fence handling preserves code blocks across chunks. Reasoning italics rebalanced across chunks.
- **Slash commands**: Auto-deployed on startup if enabled. Skills registered as slash commands.
- **Presence cache**: In-memory, per-account. Only populated if GuildPresences intent enabled. Lost on restart.
- **PluralKit integration**: Detects webhook-based messages; optionally fetches PluralKit member info.
- **Embed handling**: Inbound embed descriptions used as content. Outbound embeds for exec approvals (title + fields).
- **Reaction encoding**: Unicode and custom emoji (`name:id` format). URL-encoded for API. Max 100 users fetched per reaction.
- **Polls**: Native Discord polls, max 10 answers, max 32 days duration.
- **DM vs guild**: DMs have no permissions/threads/slash commands. Channel resolution attempts name resolution then falls back to ID.
- **Slow listener detection**: Logs if Gateway event processing > 30 seconds.

Primary tests:
- `src/discord/monitor.test.ts`
- `src/discord/monitor/message-handler.inbound-contract.test.ts`
- `src/discord/monitor/message-handler.process.test.ts`
- `src/discord/monitor/threading.test.ts`
- `src/discord/monitor/presence-cache.test.ts`
- `src/discord/api.test.ts`
- `src/discord/chunk.test.ts`
- `src/discord/send.sends-basic-channel-messages.test.ts`
- `src/discord/send.creates-thread.test.ts`
- `src/discord/targets.test.ts`
- `src/discord/probe.intents.test.ts`

#### Provider: Slack
Key files: `src/slack/monitor/provider.ts`, `src/slack/monitor/message-handler.ts`, `src/slack/send.ts`, `src/slack/accounts.ts`, `src/slack/token.ts`, `src/slack/threading.ts`, `extensions/slack/src/channel.ts`

Provider-specific quirks:
- **Bolt framework**: `@slack/bolt` for app initialization. Supports Socket Mode (via app token, outbound WebSocket) or HTTP Mode (via signing secret, inbound webhooks).
- **Token types**: Bot token (xoxb-, required for all operations), App token (xapp-, required for Socket Mode), User token (xoxp-, optional for enhanced reads). Token pair consistency validated via `auth.test()` + `api_app_id` comparison.
- **Threading**: `thread_ts` (float string) identifies thread root. Missing `thread_ts` resolution: fetches via `conversations.history()` with 60s/500-entry cache and inflight dedup. Reply-to modes: off/first/all (broadcast).
- **Text formatting**: Markdown → mrkdwn conversion. Link format: `<url|label>`. Escaping: `&amp;`, `&lt;`, `&gt;`. Preserves Slack angle tokens (`<@U123>`, `<#C456>`). Text chunked at 4000 chars.
- **Slash commands**: Ephemeral responses (user-only). Argument menus use Blocks API (button grids, 5 per row). Action ID: `openclaw_cmdarg`. Configurable name and enablement.
- **File handling**: Private URLs require bot token auth. Custom fetch wrapper (`fetchWithSlackAuth()`) manages auth once, allows redirect to CDN without re-auth. Default 20 MB media cap.
- **Workspace events**: message (subtypes: file_share, bot_message, message_changed, message_deleted, thread_broadcast), app_mention, reaction_added/removed, member_joined/left_channel, channel_created/rename/id_changed, pin_added/removed.
- **Ack reaction**: Configurable emoji + scope (default: "group-mentions"). Applied after message prepared, removed after reply if `removeAckAfterReply: true`.
- **Debouncing**: Key: `slack:{accountId}:{threadKey}:{senderId}`. Skip debounce for messages with files or control commands.
- **Channel type inference**: Prefix-based (`D*`=direct, `C*`=channel, `G*`=group, `mpim`=multi-person IM) with fallback to explicit `channel_type` field.
- **Multi-account**: Default account can use env tokens; named accounts require config-based tokens.

Primary tests:
- `src/slack/monitor.test.ts`
- `src/slack/monitor/message-handler/prepare.inbound-contract.test.ts`
- `src/slack/monitor/thread-resolution.test.ts`
- `src/slack/monitor/slash.command-arg-menus.test.ts`
- `src/slack/monitor/slash.policy.test.ts`
- `src/slack/monitor/media.test.ts`
- `src/slack/format.test.ts`
- `src/slack/threading.test.ts`
- `src/slack/targets.test.ts`
- `src/slack/resolve-channels.test.ts`

#### Provider: Signal
Key files: `src/signal/client.ts`, `src/signal/daemon.ts`, `src/signal/monitor.ts`, `src/signal/monitor/event-handler.ts`, `src/signal/send.ts`, `src/signal/identity.ts`, `extensions/signal/src/channel.ts`

Provider-specific quirks:
- **signal-cli dependency**: External Java process spawned and managed by OpenClaw. Path configurable via `channels.signal.cliPath` (default: `signal-cli` from PATH). Communication via JSON-RPC 2.0 over HTTP + SSE for events.
- **Linked device auth**: Bot registered as secondary device (not primary). User runs `signal-cli -a +E164 link`, scans QR from primary Signal. Credentials stored by signal-cli in `~/.local/share/signal-cli/`. No password/token managed by OpenClaw.
- **Daemon mode**: `signal-cli daemon --http HOST:PORT --receive-mode on-start|manual`. RPC via `POST /api/v1/rpc`, events via `GET /api/v1/events` (SSE), health via `GET /api/v1/check`.
- **SSE reconnection**: Exponential backoff (1s→10s + 20% jitter). Resets to 1s on successful event. Respects abort signal for clean shutdown.
- **Sender identification**: Dual mode — phone (E.164) or UUID. Modern Signal prefers UUIDs. Config allowlists accept both formats.
- **Attachment handling**: First attachment only per message. Retrieved via RPC (`getAttachment`) as base64, decoded and saved locally. Requires both sender AND recipient/groupId for retrieval.
- **Text styling**: Markdown converts to Signal text styles (BOLD, ITALIC, STRIKETHROUGH, MONOSPACE, SPOILER) as `[{start, length, style}]` array.
- **Group v2**: Groups use UUID-based base64-encoded groupId (not human-readable). No explicit v1/v2 flag.
- **Reaction targeting**: Requires `targetSentTimestamp` + `targetAuthor` (UUID/phone). For groups, `targetAuthor` mandatory.
- **Read receipts**: Two modes — daemon-driven (`--send-read-receipts` flag) or RPC-driven (`sendReceipt`). DM-only (not supported for groups).
- **Sync message filtering**: Messages from primary device (`syncMessage`) filtered out to prevent echo loops.
- **Default media cap**: 8 MB.

Primary tests:
- `src/signal/daemon.test.ts`
- `src/signal/format.test.ts`
- `src/signal/probe.test.ts`
- `src/signal/send-reactions.test.ts`
- `src/signal/monitor.test.ts`
- `src/signal/monitor/event-handler.inbound-contract.test.ts`
- `src/signal/monitor.event-handler.sender-prefix.test.ts`
- `src/signal/monitor.event-handler.typing-read-receipts.test.ts`

#### Provider: iMessage
Key files: `src/imessage/client.ts`, `src/imessage/monitor/monitor-provider.ts`, `src/imessage/send.ts`, `src/imessage/targets.ts`, `src/imessage/accounts.ts`, `extensions/imessage/src/channel.ts`

Provider-specific quirks:
- **imsg CLI bridge**: Spawns external `imsg` binary (configurable path, default: `"imsg"`). Communication via JSON-RPC 2.0 over stdin/stdout. The CLI accesses macOS Messages.app database natively. Not BlueBubbles — that's a separate optional extension (`extensions/bluebubbles/`).
- **macOS-only**: Requires macOS with Messages.app + imsg CLI installed.
- **No explicit login**: If `imsg` binary is available and macOS Messages account is configured, it works. Supports SSH wrapper scripts for remote Mac hosts (auto-detected from CLI path pattern like `ssh -T user@host imsg`).
- **iMessage vs SMS**: Service parameter: `"imessage"`, `"sms"`, `"auto"`. Can force SMS via `service: "sms"` config or target prefix `sms:+1234567890`. Region parameter for SMS (default: `"US"`).
- **Target parsing**: Prefixes `chat_id:`, `chat_guid:`, `chat_identifier:`, `imessage:`, `sms:`, `auto:` for routing. Bare handle → service="auto".
- **No native reactions/tapbacks**: Core iMessage only supports text + media. BlueBubbles extension has `sendBlueBubblesReaction()` separately.
- **Echo detection**: 5-second cache prevents replaying own messages. Scoped by `{accountId}:{target}`.
- **Remote attachments**: If `remoteHost` configured, attachment paths prefixed for SCP fetch from remote Mac.
- **Group behavior**: Groups identified by `chat_id` (numeric). Default `requireMention=true` for groups (configurable per-group). Participants tracked as phone/email array.
- **Reply-to metadata**: `reply_to_id`, `reply_to_text`, `reply_to_sender` fields when message is a reply.
- **RPC methods**: `send`, `watch.subscribe`, `watch.unsubscribe`, `chats.list` + notification events (`message`, `error`).
- **Default media cap**: 16 MB. One media per message (multiple media handled via reply batching).
- **Default probe timeout**: 10 seconds.

Primary tests:
- `src/imessage/send.test.ts`
- `src/imessage/targets.test.ts`
- `src/imessage/probe.test.ts`
- `src/imessage/monitor.skips-group-messages-without-mention-by-default.test.ts`
- `src/imessage/monitor.updates-last-route-chat-id-direct-messages.test.ts`

#### Extension: MS Teams
Key files: `extensions/msteams/src/channel.ts`, `extensions/msteams/src/token.ts`, `extensions/msteams/src/sdk.ts`, `extensions/msteams/src/conversation-store.ts`, `extensions/msteams/src/graph-upload.ts`, `extensions/msteams/src/file-consent.ts`

Extension-specific quirks:
- **Azure AD / Bot Framework OAuth**: Three required credentials: `appId`, `appPassword`, `tenantId`. Resolved from config (`channels.msteams.*`) or env vars (`MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`). Uses `@microsoft/agents-hosting` SDK with `MsalTokenProvider` for two scopes: Graph API and Bot Framework.
- **Webhook-based**: Receives activities via HTTP webhook (default `/api/messages` on port 3978). CloudAdapter handles JWT verification from Teams. No polling mode.
- **Conversation types**: personal (1:1 DM), groupChat, channel. Each type has different media handling strategy.
- **Proactive messaging**: Requires stored `ConversationReference` (file-based, one JSON per conversation in `<stateDir>/msteams-conversations/`). Uses `adapter.continueConversation()` to send without active webhook context.
- **Media strategy by type**: Personal <4MB image → base64 inline; personal >=4MB → FileConsentCard (user must accept, then upload to consent URL); group/channel image → base64 inline; group/channel non-image → upload to SharePoint/OneDrive via Graph API + sharing link.
- **Adaptive Cards**: Full v1.5+ support for rich interactive content. Polls implemented as Adaptive Cards with `Action.Submit` buttons (file-based store, 30-day TTL).
- **Mention handling**: Teams wraps mentions in `<at>...</at>` tags; stripped via `stripMSTeamsMentionTags()` for NLP.
- **Tenant-scoped**: Single bot per tenant; multi-tenant not supported.
- **Retry policy**: Exponential backoff (250ms base, 10s max). Classifies errors: auth (401/403), throttled (429), transient (5xx/408), permanent (4xx). Respects `Retry-After` header.
- **Text chunk limit**: 4000 characters.

Primary tests:
- `extensions/msteams/src/inbound.test.ts`
- `extensions/msteams/src/messenger.test.ts`
- `extensions/msteams/src/policy.test.ts`
- `extensions/msteams/src/probe.test.ts`
- `extensions/msteams/src/attachments.test.ts`
- `extensions/msteams/src/media-helpers.test.ts`
- `extensions/msteams/src/file-consent-helpers.test.ts`
- `extensions/msteams/src/conversation-store-fs.test.ts`
- `extensions/msteams/src/polls.test.ts`
- `extensions/msteams/src/channel.directory.test.ts`

#### Extension: Voice Call
Key files: `extensions/voice-call/index.ts`, `extensions/voice-call/runtime.ts`, `extensions/voice-call/src/manager/`, `extensions/voice-call/src/providers/`, `extensions/voice-call/src/media-stream.ts`

Extension-specific quirks:
- **Multi-provider telephony**: Supports Twilio (Programmable Voice + Media Streams), Telnyx (Call Control v2), Plivo (Voice XML), and Mock (local dev). Each provider has its own auth: Twilio (Account SID + Auth Token), Telnyx (Bearer token + Ed25519 webhook signatures), Plivo (Auth ID + Auth Token).
- **Call state machine**: States flow monotonically: `initiated → ringing → answered → active ↔ speaking ↔ listening → [completed|hangup-user|hangup-bot|timeout|error|failed|no-answer|busy|voicemail]`. Terminal states lock the call. Idempotent event processing via `processedEventIds` set.
- **Two outbound modes**: "notify" (deliver message via TwiML `<Say>`, auto-hangup) vs "conversation" (stay open with bidirectional streaming audio).
- **Audio codec**: 8-bit mu-law (G.711) at 8 kHz mono, 160-byte chunks (20ms frames). TTS output (16-bit PCM) resampled and converted to mu-law via `convertPcmToMulaw8k()`.
- **Streaming transcription**: OpenAI Realtime STT (`gpt-4o-transcribe`) via WebSocket. Built-in VAD with configurable silence threshold (800ms default). Barge-in supported — user speech clears TTS queue.
- **TTS providers**: OpenAI, ElevenLabs, Edge TTS. Twilio fallback: TwiML `<Say>` with Polly voices when media stream unavailable.
- **Webhook tunnel**: Supports ngrok, Tailscale serve/funnel, or manual `publicUrl` for exposing webhooks to providers.
- **Concurrent call limit**: Default 1 (configurable). Max duration: 300s (5 min, configurable).
- **Persistence**: Call records logged to `<stateDir>/voice-calls/calls.jsonl`. Non-terminal calls recovered on startup.
- **Gateway tools**: `voicecall.initiate`, `voicecall.continue` (speak + wait for transcript), `voicecall.speak` (one-way), `voicecall.end`, `voicecall.status`.

Primary tests:
- `extensions/voice-call/src/manager.test.ts`
- `extensions/voice-call/src/media-stream.test.ts`
- `extensions/voice-call/src/config.test.ts`
- `extensions/voice-call/src/providers/twilio.test.ts`
- `extensions/voice-call/src/providers/plivo.test.ts`
- `extensions/voice-call/src/webhook-security.test.ts`

#### Extension: Google Chat
Key files: `extensions/googlechat/index.ts`, `extensions/googlechat/src/channel.ts`, `extensions/googlechat/src/monitor.ts`, `extensions/googlechat/src/auth.ts`, `extensions/googlechat/src/api.ts`

Extension-specific quirks:
- **Service account auth only**: Google Workspace bot apps use service account JSON credentials (file/inline/env/ADC). User OAuth not supported. Credential sources resolved in order: inline `serviceAccount` → `serviceAccountFile` → env `GOOGLE_CHAT_SERVICE_ACCOUNT` / `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE` → Application Default Credentials.
- **JWT webhook verification**: Two mutually exclusive modes. `app-url`: verifies Google-signed ID token, checks issuer is `chat@system.gserviceaccount.com` or Add-on issuer pattern. `project-number`: verifies JWT signature against public certs from Google's metadata endpoint (cached 10 min). Multiple accounts can share the same webhook path — tried in order until verification succeeds.
- **Workspace Add-on dual format**: Detects `commonEventObject.hostApp === "CHAT"` and converts Add-on message envelope to standard Chat API schema. Extracts bearer token from `authorizationEventObject.systemIdToken` if not in Authorization header.
- **Message limit**: 4000 chars per message (configurable via `textChunkLimit`). Chunked replies: first chunk edits typing indicator message, remaining sent as new messages in same thread.
- **Typing indicator limitation**: Only message mode works (reaction mode requires user OAuth, which service accounts lack). Falls back to message mode with warning if `typingIndicator="reaction"` configured.
- **Blocking streaming**: `blockStreaming: true`; coalesces output (minChars 1500, idleMs 1000). Google Chat discourages rapid message bursts.
- **DM resolution**: User targets (`users/{id}` or `users/{email}`) don't directly map to spaces; requires `findGoogleChatDirectMessage` API call to locate space name.
- **Multipart media upload**: Custom multipart/related format with UUID-based boundary. Max 20 MB per attachment (configurable via `mediaMaxMb`). Attachment upload tokens consumed on send — cannot reuse.
- **Target normalization**: Strips `googlechat:`, `google-chat:`, `gchat:`, `user:`, `space:` prefixes. Email addresses normalized to `users/{email}` (lowercase).
- **Multi-account**: Separate `webhookPath` per account (default `/googlechat`). Per-account credentials, DM/group policies, allowlists. Default account: `DEFAULT_ACCOUNT_ID` or first configured.

Primary tests:
- `extensions/googlechat/src/api.test.ts`
- `extensions/googlechat/src/monitor.test.ts`
- `extensions/googlechat/src/targets.test.ts`

#### Extension: Matrix
Key files: `extensions/matrix/index.ts`, `extensions/matrix/src/channel.ts`, `extensions/matrix/src/matrix/monitor/index.ts`, `extensions/matrix/src/matrix/send.ts`, `extensions/matrix/src/matrix/client/create-client.ts`

Extension-specific quirks:
- **matrix-bot-sdk**: Uses `@vector-im/matrix-bot-sdk` 0.8.0-element.3 for protocol handling. Shared client singleton per (homeserver, userId, encryption) tuple — lazily created, prevents concurrent initialization.
- **E2EE support**: Optional via `channels.matrix.encryption=true`. Requires `@matrix-org/matrix-sdk-crypto-nodejs` (Rust-based native module). Crypto state stored in SQLite, tied to device/token. Manual device verification required. Encrypted media decrypted client-side. Encrypted events logged as warnings if crypto disabled.
- **Credential management**: Password login with token caching at `{stateDir}/credentials/matrix/credentials.json`. Env vars: `MATRIX_HOMESERVER`, `MATRIX_USER_ID`, `MATRIX_ACCESS_TOKEN`, `MATRIX_PASSWORD`, `MATRIX_DEVICE_NAME`. Token loss = crypto state loss (device ID implicit in accessToken).
- **Room config**: Per-room settings via room ID or alias. Wildcard `"*"` applies to all unmapped rooms. Per-room overrides: `requireMention`, `autoReply`, `tools`, `skills`, `systemPrompt`.
- **Threading model**: `m.thread` rel_type + `m.in_reply_to`. `replyToMode`: off/first/all. `threadReplies`: off/inbound/always. Thread fallback ensures replies render in timeline for clients without thread support.
- **Poll support**: MSC3381 — handles both `m.poll.*` (stable) and `org.matrix.msc3381.poll.*` (draft) types. Polls rendered as text inbound.
- **Voice messages**: Uses MSC3245 (`org.matrix.msc3245.voice`) + MSC1767 (`org.matrix.msc1767.audio`) for voice message metadata including duration.
- **Message limits**: 4000 char text (configurable `textChunkLimit`), 20 MB media default (`mediaMaxMb`). Markdown → Matrix custom HTML via `markdownToMatrixHtml()`.
- **Allowlist normalization**: `@localpart:server` (case-insensitive, lowercased). Supports prefixes: `user:@alice:example.org`, `room:!abc:example.org`. Auto-join on invite if allowlisted.
- **Actions**: send, poll, react, read, edit, delete, pin, unpin, list-pins, member-info, channel-info — each gated via action config.

Primary tests:
- `extensions/matrix/src/channel.directory.test.ts`
- `extensions/matrix/src/matrix/accounts.test.ts`
- `extensions/matrix/src/matrix/client.test.ts`
- `extensions/matrix/src/matrix/format.test.ts`
- `extensions/matrix/src/matrix/monitor/allowlist.test.ts`
- `extensions/matrix/src/matrix/monitor/media.test.ts`
- `extensions/matrix/src/matrix/monitor/rooms.test.ts`
- `extensions/matrix/src/matrix/poll-types.test.ts`
- `extensions/matrix/src/matrix/send/targets.test.ts`
- `extensions/matrix/src/matrix/send.test.ts`
- `extensions/matrix/src/resolve-targets.test.ts`

#### Extension: LINE
Key files: `extensions/line/index.ts`, `extensions/line/src/channel.ts`, `src/line/monitor.ts`, `src/line/send.ts`, `src/line/webhook.ts`, `src/line/markdown-to-line.ts`

Extension-specific quirks:
- **LINE Messaging API v3**: Uses `@line/bot-sdk`. Webhook-based inbound (no polling). Channel Access Token + Channel Secret required. Token resolution: config `channelAccessToken` → `tokenFile` → env `LINE_CHANNEL_ACCESS_TOKEN`. Multi-account via `channels.line.accounts[accountId]`.
- **Webhook security**: HMAC-SHA256 signature validation on `X-Line-Signature` header using raw HTTP body. Uses `crypto.timingSafeEqual()` to prevent timing attacks. Returns 200 immediately, processes events asynchronously.
- **No threads, no reactions**: LINE has no thread or reaction support. All replies go to same chat sequentially. Postback events used for button/menu responses.
- **Blocking streaming**: `blockStreaming: true`. LINE doesn't support streaming responses.
- **Message limit**: 5000 chars per message (auto-chunked). Media pushed as separate messages. Quick replies only on last message in sequence.
- **Markdown → Flex Messages**: Tables auto-converted to Flex bubble cards. Code blocks → styled Flex cards. Links extracted as Flex links. Bold/italic stripped (LINE doesn't support in plain text). Result: `ProcessedLineMessage { text, flexMessages[] }`.
- **Rich message directives**: Agent prompt hints for rich messages: `[[quick_replies: ...]]`, `[[confirm: Question? | Yes | No]]`, `[[buttons: Title | Text | Btn1:action]]`, `[[location: Name | Address | lat | lng]]`, `[[media_player: ...]]`, `[[event: ...]]`, `[[device: ...]]`.
- **`/card` command**: Auto-registered with 7 types: info, image, action, list, receipt, confirm, buttons. LINE-only (fallback text on other channels).
- **Loading animation**: Sent during processing as keepalive. Auto-stops on first real message send.
- **Sticker metadata**: Package ID → common name lookup (e.g., "11537" → "Cony"). Sticker events include sticker keywords.
- **Japan/Taiwan/Thailand focus**: Marketed for these regions. Rich Menu links are region-aware.
- **No directory APIs**: `directory.self()` returns null, `directory.listPeers()` returns []. LINE doesn't expose group membership APIs.
- **Media**: Default max 10 MB (configurable `mediaMaxMb`). User profile cache: 5-minute TTL.

Primary tests:
- `extensions/line/src/channel.logout.test.ts`
- `extensions/line/src/channel.sendPayload.test.ts`
- `src/line/accounts.test.ts`
- `src/line/auto-reply-delivery.test.ts`
- `src/line/bot-handlers.test.ts`
- `src/line/bot-message-context.test.ts`
- `src/line/flex-templates.test.ts`
- `src/line/markdown-to-line.test.ts`
- `src/line/probe.test.ts`
- `src/line/reply-chunks.test.ts`
- `src/line/rich-menu.test.ts`
- `src/line/send.test.ts`
- `src/line/signature.test.ts`
- `src/line/template-messages.test.ts`
- `src/line/webhook.test.ts`

#### Extension: Feishu
Key files: `extensions/feishu/index.ts`, `extensions/feishu/src/channel.ts`, `src/feishu/monitor.ts`, `src/feishu/send.ts`, `src/feishu/client.ts`, `src/feishu/streaming-card.ts`

Extension-specific quirks:
- **Lark SDK**: Uses `@larksuiteoapi/node-sdk`. WebSocket event listener for `im.message.receive_v1` events. SDK 2.0 event schema with legacy fallback (`data.message` primary, `data.event.message` fallback).
- **Domain duality**: Feishu (China) at `open.feishu.cn` vs Lark (Global) at `open.larksuite.com`. Same API surface, different domains required for auth. Keywords resolve automatically: "feishu"/"cn"/"china" → feishu.cn; "lark"/"global"/"intl" → larksuite.com. Custom `https://` domains allowed.
- **Tenant-scoped tokens**: Access tokens are per-tenant (not per-user), 2-hour TTL. Obtained via `POST /auth/v3/tenant_access_token/internal` with app credentials. No refresh token rotation — obtains new token each startup. Credentials: `appId` + `appSecret`/`appSecretFile` → env `FEISHU_APP_ID`/`FEISHU_APP_SECRET`.
- **CardKit streaming**: Typing indicator effect via CardKit API. Creates streaming card entity with `streaming_mode: true`, streams incremental text updates via `POST /cardkit/v2/update`. Shows "[Generating...]" placeholder while streaming. Tenant token cached in memory (2-hour TTL, refreshed 1 minute early).
- **ID scheme**: Open ID (`ou_*`, user), Union ID (`on_*`, cross-tenant stable), Chat ID (`oc_*`, group). No usernames — unlike Slack/Discord. Target normalization strips `feishu:`, `lark:`, `user:`, `group:`, `chat:`, `dm:` prefixes.
- **Markdown → Feishu Post**: Converts Markdown to Feishu rich text format. Supports bold, italic, strikethrough, code, links, headings, code blocks. Language key: `zh_cn` required, `en_us` optional.
- **No threads, no reactions, no polls**: Single conversation per chat. `blockStreaming: true` by default (overrideable per-account).
- **Message limit**: 2000 char text chunk limit. Chunk modes: `"length"` (default, by char limit) or `"newline"` (split on every newline).
- **Mention handling**: `mentions[].key` is a placeholder string in message text. Extracted and removed before text processing. Require-mention default true in groups.
- **Media**: Supported inbound types: text, image, file, audio, media, sticker. Download via `client.im.messageResource.get()`. Max 30 MB default.
- **Multi-account**: Per-account domain selection, credentials, DM/group policies. `appSecretFile` support for secret managers (Sealed Secrets). Default account uses env vars if no explicit config.
- **Pairing system**: Human-readable approval codes (e.g., "FEISHU-ABC123"). Metadata stored: openId, unionId, name, createdAt, lastSeenAt. Approval via `openclaw pairing approve feishu <code>`.

Primary tests:
- `src/feishu/format.test.ts`

### Change Control UI + Canvas Host
Touch points:
- Control UI serve and basePath: `src/gateway/control-ui.ts`, `src/gateway/control-ui-shared.ts`
- Asset build and resolution: `src/infra/control-ui-assets.ts` (and callers in gateway startup)
- Canvas host: `src/canvas-host/*` (including a2ui), and gateway boot wiring that mounts it

Core invariants:
- The gateway can lazily build missing UI assets and then serve from `dist/control-ui/`; do not break the "resolve or build then retry" flow.
- HTTP routing order matters: canvas host endpoints and WS upgrades can intercept before the gateway WS server when enabled.
- Base paths must be normalized consistently across UI and gateway; regressions show up as broken asset URLs or mismatched WS endpoints.

Checklist:
1. When changing UI basePath or control-ui root discovery, verify the gateway HTTP mux order and upgrade interception behavior.
2. When changing canvas host enablement, ensure UI surfaces that assume canvas availability handle disabled state cleanly.

Primary tests:
- `src/gateway/control-ui.test.ts`
- `src/canvas-host/server.test.ts`
- `src/infra/control-ui-assets.test.ts`

### Change Logging + Redaction
Touch points:
- Logger entrypoints + config: `src/logger.ts`, `src/logging/config.ts`
- Redaction: `src/logging/redact.ts`
- Gateway WS logging: `src/gateway/ws-logging.ts`, `src/gateway/ws-log.ts`

Core invariants:
- Logs must remain paste-safe by default: redaction is on by default for tool-heavy output, and patterns must not accidentally leak secrets.
- Logging changes are user-facing: CLI/TUI output, gateway logs, and tests depend on stable prefixes and formatting.

Checklist:
1. If you add a new place that can print secrets (tokens, API keys, auth headers), ensure it flows through redaction helpers or prints only masked identifiers.
2. If you change log line formatting, update parsing/capture tests and confirm operator UX (status tables, ws logs) still aligns.
3. If you change redaction patterns, add at least one regression test that proves the new pattern doesn't over-redact normal text.

Primary tests:
- `src/logging/redact.test.ts`
- `src/logging/console-prefix.test.ts`
- `src/gateway/ws-log.test.ts`

### Change Ops + Updates (Self-Update, Services, Restarts)
Touch points:
- CLI update UX and switching install kinds: `src/cli/update-cli.ts`
- Update core logic: `src/infra/update-runner.ts`, `src/infra/update-check.ts`, `src/infra/update-startup.ts`, `src/infra/update-global.ts`, `src/infra/update-channels.ts`
- Restart and restart signaling: `src/infra/restart.ts`, `src/infra/restart-sentinel.ts`
- Daemon/service lifecycle (platform adapters): `src/daemon/service.ts`, `src/daemon/service-env.ts`, `src/daemon/launchd.ts`, `src/daemon/systemd.ts`, `src/daemon/schtasks.ts`
- CLI daemon lifecycle: `src/cli/daemon-cli/*`

Core invariants:
- Git updates are safety-first:
  - `runGatewayUpdate()` in git mode refuses to run when the working tree is dirty (excluding `dist/control-ui/`), returning status=skipped reason=dirty.
  - dev channel updates fetch upstream and use a detached preflight worktree to test up to 10 candidate commits with install+lint+build; it rebases onto the first "good" commit and aborts rebase on failure. (`src/infra/update-runner.ts`)
  - stable/beta git updates fetch tags and `git checkout --detach <tag>`, then run deps install, build, ui build, restore `dist/control-ui/` to avoid leaving the repo dirty, and run `openclaw doctor --non-interactive` with `OPENCLAW_UPDATE_IN_PROGRESS=1`. (`src/infra/update-runner.ts`)
- Package/global updates are manager-aware:
  - Manager detection is by locating the global package root under `npm root -g` / `pnpm root -g` / Bun global root, and comparing realpaths. (`src/infra/update-global.ts`)
  - Before global updates, stale rename dirs (`.<pkg>-*`) are cleaned to reduce failed installs after interrupted updates. (`src/infra/update-global.ts`)
  - Beta channel can fall back to `latest` if it is newer than `beta` (to avoid beta lagging stable). (`src/infra/update-check.ts`)
- `openclaw update` can switch install kind depending on requested channel:
  - switching git -> package uses the detected global manager and installs `<pkg>@<tag>`.
  - switching package -> git clones/uses a git checkout (default `~/.openclaw`) and then installs that directory globally (so `openclaw` resolves to the git checkout). (`src/cli/update-cli.ts`)
- Post-update, plugin state is normalized to the update channel and can rewrite config:
  - `syncPluginsForUpdateChannel()` may switch bundled vs npm plugins; `updateNpmInstalledPlugins()` updates npm-installed plugins; config is rewritten when these operations change it. (`src/cli/update-cli.ts`, `src/plugins/update.ts`)
- Startup update checks are rate-limited and conservative:
  - `runGatewayUpdateCheck()` runs at most once per 24h, only for package installs, and is disabled in Nix mode and when `cfg.update.checkOnStart === false`.
  - It stores state under `<stateDir>/update-check.json` and logs an "update available" hint only once per version+tag. (`src/infra/update-startup.ts`)
- Restarts have multiple mechanisms; do not mix them casually:
  - `triggerOpenClawRestart()` tries launchctl (macOS) or systemd (Linux); other platforms are unsupported by this helper. Windows service restarts are handled via the daemon lifecycle adapters (Scheduled Task) rather than `triggerOpenClawRestart()`. (`src/infra/restart.ts`, `src/daemon/service.ts`)
  - SIGUSR1 restart is gated by an in-process authorization window (`authorizeGatewaySigusr1Restart` / `consumeGatewaySigusr1RestartAuthorization`) to prevent arbitrary external restarts. (`src/infra/restart.ts`)
  - `RestartSentinel` persists restart/update outcomes across process restarts via `<stateDir>/restart-sentinel.json`. (`src/infra/restart-sentinel.ts`)

Checklist (when changing update/restart behavior):
1. Preserve "don't brick installs" behavior: dirty detection, preflight for dev, restore `dist/control-ui/`, and non-interactive doctor-on-update.
2. Preserve manager detection and path semantics (realpath comparisons, Bun global root).
3. Preserve startup update check rate limiting and "notify once per version".
4. Preserve restart security: SIGUSR1 authorization and platform service boundaries.
5. Update tests:
   - `src/infra/update-*.test.ts`, `src/cli/update-cli.test.ts`
   - `src/infra/restart*.test.ts`
   - daemon adapters `src/daemon/*.test.ts` when changing platform behavior.

### Add or Change a Slash Command / Directive
Touch points:
- Command registry: `src/auto-reply/commands-registry*.ts`
- Command handling: `src/auto-reply/reply/commands-*.ts`
- Directive parsing/apply: `src/auto-reply/reply/directive-handling.*.ts`, `src/auto-reply/reply/get-reply-directives.ts`
- Channel monitors may need coarse detection updates: `src/auto-reply/command-detection.ts`

Core invariants:
- Plugin commands are matched before built-ins; reserved command names and auth defaults are part of the contract. (`src/auto-reply/commands-registry.ts`)
- Command normalization rules (aliases, mention formats) must remain stable; changing them can break existing user workflows.
- Directive parsing and application are separate from command handling; directives are applied in `get-reply-directives.ts` and affect agent behavior silently (no user-facing response).
- Gating is multi-layered: `cfg.commands.*` flags, `shouldHandleTextCommands` for native surfaces, and `dock.commands.enforceOwnerForCommands` for owner enforcement.

Checklist:
1. Decide whether it's a plugin command (bypass agent) or a built-in command.
2. Update command normalization rules if new aliases/mention formats are needed.
3. Update gating:
   - `cfg.commands.*` flags
   - `shouldHandleTextCommands` behavior for native surfaces
   - owner enforcement (`dock.commands.enforceOwnerForCommands`) when relevant
4. Add tests in `src/auto-reply/*.test.ts` or `src/auto-reply/reply/*.test.ts`.

Primary tests:
- `src/auto-reply/commands-registry.test.ts`
- `src/auto-reply/reply/commands.test.ts`
- `src/auto-reply/reply/commands-parsing.test.ts`
- `src/auto-reply/reply/commands-policy.test.ts`

### Add a New Channel Plugin
Touch points:
- Plugin discovery/loader: `src/plugins/*`
- Channel plugin contract: `src/channels/plugins/types.*.ts`
- Dock/capabilities: `src/channels/dock.ts` and/or plugin meta
- Onboarding/status issues docs/tests

Core invariants:
- ChannelPlugin type requires: `id`, `meta`, `capabilities`, and a `config` adapter with `listAccountIds` + `resolveAccount`. Optional adapters: `pairing`, `outbound` (with `deliveryMode`), `groups`, `mentions`, `security`. (`src/channels/plugins/types.plugin.ts`)
- Dock wraps plugin metadata for shared code paths; resolves `allowFrom` formatting and mention gating defaults. (`src/channels/dock.ts`)
- Mention gating is multi-layered: `requireMention` -> `canDetectMention` -> `wasMentioned` / `implicitMention`. Command auth can bypass mention requirement. (`src/channels/mention-gating.ts`)
- Plugin precedence is deterministic: config-specified > workspace > global state dir > bundled; duplicate IDs are disabled. Registration must be synchronous. (`src/plugins/loader.ts`, `src/plugins/discovery.ts`)

Checklist:
1. Implement the channel plugin and adapters (config/security/outbound/status/etc).
2. Ensure allowlist + mention gating semantics match other channels.
3. Ensure pairing and allowFrom persistence (if supported) uses the shared store patterns.
4. Add status issue collectors and probe/audit hooks where meaningful.

Primary tests:
- `src/plugins/loader.test.ts`
- `src/plugins/discovery.test.ts`
- `src/channels/plugins/load.test.ts`
- `src/channels/plugins/config-writes.test.ts`
- `src/channels/mention-gating.test.ts`

### Change Process + Concurrency
Touch points:
- Command queue + lanes: `src/process/command-queue.ts`, `src/process/lanes.ts`
- Exec helpers: `src/process/exec.ts`, `src/process/spawn-utils.ts`
- Signal bridging: `src/process/child-process-bridge.ts`
- Gateway lane config: `src/gateway/server-lanes.ts`

Core invariants:
- Execution is serialized within a lane (FIFO); each lane has independent queue and active counter with configurable `maxConcurrent` (default 1).
- `CommandLane` enum (Main, Cron, Subagent, Nested) defines the built-in lanes; dynamic lane names (e.g., `auth-probe:*`, `session:probe-*`) suppress error logs.
- Queue pump is idempotent (`draining` flag); concurrent pump invocations are no-ops.
- Wait threshold warns after `warnAfterMs` (default 2000ms) via `onWait` callback — diagnostic, not enforcement.
- `exec.ts` auto-appends `.cmd` suffix for npm/pnpm/yarn/npx on Windows.
- `runCommandWithTimeout` sets `NPM_CONFIG_FUND=false` for npm/node commands.
- `spawnWithFallback` only retries on `EBADF` (file descriptor errors); all other errors propagate immediately.
- Signal bridging (`attachChildProcessBridge`) forwards SIGTERM/SIGINT/SIGHUP/SIGQUIT (Unix) or SIGTERM/SIGINT/SIGBREAK (Windows) to child; detaches on exit.

Checklist:
1. If you change lane concurrency or add a new lane, audit callers of `enqueueCommandInLane` — wrong concurrency can deadlock approval flows or starve cron runs.
2. If you change queue pump logic, verify FIFO ordering and the draining idempotency guarantee.
3. If you change exec helpers (Windows .cmd suffix, env merging), verify cross-platform behavior.
4. If you change signal bridging, verify child processes are cleaned up on gateway shutdown.

Primary tests:
- `src/process/command-queue.test.ts`
- `src/process/exec.test.ts`

### Change Terminal + Rendering
Touch points:
- Theme singleton + color support: `src/terminal/theme.ts`, `src/terminal/palette.ts`
- ANSI stripping + visible width: `src/terminal/ansi.ts`
- Table rendering: `src/terminal/table.ts`
- Documentation links: `src/terminal/links.ts`
- Progress line (TTY): `src/terminal/progress-line.ts`

Core invariants:
- `theme` is a module-level singleton; `baseChalk` level depends on `NO_COLOR` and `FORCE_COLOR` env vars at import time.
- `NO_COLOR` precedence: if `NO_COLOR` is set and `FORCE_COLOR` is not set, forces chalk.level=0. `FORCE_COLOR` (truthy, not "0") overrides `NO_COLOR`.
- `isRich()` returns `chalk.level > 0`; all conditional coloring should use this or `colorize()`.
- `visibleWidth()` strips both SGR (`\x1b[...m`) and OSC-8 link sequences; uses `Array.from()` for multi-codepoint grapheme handling.
- Table rendering is ANSI-aware: never splits inside escape sequences; preserves SGR state across wrapped lines. Column constraints: `minWidth` (enforced), `maxWidth` (soft cap), `flex` (fills remaining), `align` (left/right/center).
- Progress line writes only when `stream.isTTY === true`; uses `\r\x1b[2K` (carriage return + clear line).
- `LOBSTER_PALETTE` is hardcoded and must stay in sync with docs/cli theming.

Checklist:
1. If you change theme colors or `isRich()` logic, verify NO_COLOR/FORCE_COLOR behavior and test in a color-restricted terminal.
2. If you change `visibleWidth()` or `stripAnsi()`, verify table alignment remains correct (ANSI-aware wrapping depends on it).
3. If you change table column constraints, verify edge cases: zero-width columns, columns exceeding terminal width, deeply nested ANSI sequences.
4. If you change `formatDocsLink()`, verify links render correctly in both rich terminals (clickable OSC-8) and plain terminals (plain text fallback).

Primary tests:
- `src/terminal/table.test.ts`

### Change Browser Control
Touch points:
- Lifecycle: `src/browser/server.ts` (start/stop)
- Configuration + port derivation: `src/browser/config.ts`
- Runtime state + route context: `src/browser/server-context.ts`
- Gateway sidecar wiring: `src/gateway/server-startup.ts` (starts browser control)

Core invariants:
- Start/stop are idempotent: module-level `state` variable; `startBrowserControlServerFromConfig()` returns cached state if already running; `stopBrowserControlServer()` clears state to null.
- Always binds to `127.0.0.1` (localhost only); non-localhost binding is a security boundary.
- Port derivation cascade: control port defaults to 18791; CDP port = controlPort + 1. If `OPENCLAW_GATEWAY_PORT` env is set, controlPort = gatewayPort + 2. Can override via `browser.profiles[name].cdpPort`.
- Profile defaults: auto-creates "openclaw" profile (driver="openclaw") and "chrome" profile (driver="extension", routes to relay server) if missing.
- Chrome extension relay server is started eagerly if any profile uses driver="extension".
- `cdpIsLoopback` flag: true for localhost/127.0.0.1/::1/etc.; affects whether Playwright persistent connection or HTTP CDP endpoints are used for tab operations.
- Tab stickiness: `lastTargetId` persists across operations to keep snapshot+act consistent without requiring explicit targetId.
- Profile isolation: each profile has independent `ProfileRuntimeState` (running flag, lastTargetId).

Checklist:
1. If you change port derivation, verify the cascade (gateway port -> control port -> CDP port) and that defaults remain stable.
2. If you change start/stop lifecycle, verify idempotency — multiple start calls must not leak servers or ports.
3. If you add a new profile driver, ensure relay server eagerness logic still only starts when needed.
4. If you change tab operations, preserve `lastTargetId` stickiness and the loopback-vs-remote branching.

Primary tests:
- `src/browser/config.test.ts`
- `src/browser/server.test.ts`
- `src/browser/server-context.ensure-tab-available.prefers-last-target.test.ts`
- `src/browser/server-context.remote-tab-ops.test.ts`

### Change Agent Dormancy
Touch points:
- Dormancy state store: `src/agents/dormancy/store.ts`
- In-memory cache + business logic: `src/agents/dormancy/dormancy.ts`
- Message processing gate: `src/agents/dormancy/gate.ts`
- Type definitions: `src/agents/dormancy/types.ts`
- Agent tool: `src/agents/tools/dormancy-tool.ts`
- Tool registration: `src/agents/openclaw-tools.ts`
- System prompt: `src/agents/system-prompt.ts` (tool summary + dedicated section)
- Channel monitor integration: dormancy gate calls in `src/auto-reply/*`, `src/web/*`, `src/telegram/*`, `src/discord/*`, `src/signal/*`, `src/imessage/*`, `src/slack/*`, and all extension monitors (`extensions/*/src/monitor*.ts`)
- Plugin runtime API: `src/plugins/runtime/types.ts` (`ApplyDormancyGate`), `src/plugins/runtime/index.ts`

Core invariants:
- Dormancy is runtime state (JSON files at `~/.openclaw/agents/<id>/dormancy.json`), not config — changes take effect immediately without gateway restart.
- `activateAgent()` is idempotent: if already active, returns current state without resetting the `activatedAt` cursor. This prevents cursor reset on repeated activation.
- `deactivateAgent()` always clears `activatedAt` (cursor reset to null). Reactivating later starts fresh — old messages won't replay.
- The dormancy gate runs two checks in fail-fast order: (1) is agent dormant? → skip; (2) is message timestamp before activation cursor? → skip. Check 2 uses strict `<` comparison — messages exactly at cursor time ARE processed.
- Agent ID normalization uses `normalizeAgentId()` consistently across store, cache, gate, and tool; mismatched normalization causes cache misses and ghost state.
- The dormancy gate is inserted in EVERY channel monitor after `resolveAgentRoute()` — core channels AND extension channels. Missing a gate means a dormant agent will reply on that channel.
- Extension channels access the gate via the plugin runtime API (`applyDormancyGate` on the plugin runtime object), not direct core imports.
- Authorization for cross-agent dormancy control uses `subagents.allowAgents` from the requester's agent config; `["*"]` allows all, empty allows self-management only.
- Tool schema uses `stringEnum()` (not `Type.Union`) for the `action` parameter — some LLM providers reject nested `anyOf` JSON Schema.
- History fetch on activation (`historyLimit`) is best-effort: failure returns a warning in `historyWarning` but does not fail the activation.
- In-memory cache has no TTL — manual invalidation via `invalidateDormancyCache()` only. External writes to the dormancy JSON file are invisible until cache is invalidated.
- Store validation: `dormant` coerced via `=== true` (non-boolean → false); `activatedAt` validated via `isValidIsoDate()` (invalid → null); version mismatch → returns fresh default state.

Checklist:
1. If you add a new channel monitor (core or extension), add the dormancy gate after route resolution — without it, dormant agents will reply on that channel.
2. If you change the activation cursor logic, verify the fail-fast order (dormant check before cursor check) and the strict `<` comparison boundary.
3. If you change agent ID handling anywhere in the dormancy stack, ensure `normalizeAgentId()` is used consistently across store, cache, and gate.
4. If you change the tool schema, use `stringEnum()` — not `Type.Union` — for action parameters (LLM provider compatibility).
5. If you add a new dormancy state field, update the store validation defaults and the type definition in `types.ts`.
6. If you change the system prompt sections for dormancy, ensure they are gated on `availableTools.has("agent_dormancy")` and excluded in minimal/subagent mode.

Primary tests:
- No dedicated test files yet. Dormancy behavior is integration-tested via the dormancy gate in channel monitors and the tool execute path. Consider adding:
  - `src/agents/dormancy/dormancy.test.ts` (cache + state transitions + idempotency)
  - `src/agents/dormancy/gate.test.ts` (fail-fast order + cursor boundary + edge cases)
  - `src/agents/tools/dormancy-tool.test.ts` (authorization + actions + history fetch)

### Change Connection Approval (TOFU Auth)
Touch points:
- Pairing HTTP endpoints: `src/gateway/pair-http.ts` (`/pair/request`, `/pair/status`)
- Rate limiting: `src/gateway/pair-rate-limit.ts` (multi-layer in-memory limiter)
- Ban management: `src/gateway/pair-ban.ts` (persistent IP ban store)
- Auth resolution: `src/gateway/auth.ts` (approval mode in `resolveGatewayAuth`, `authorizeGatewayConnect`)
- WS bypass: `src/gateway/server/ws-connection/message-handler.ts` (approval mode device auth bypass)
- Config schema: `src/config/zod-schema.ts` (approval object with `.strict()`), `src/config/types.gateway.ts` (`GatewayApprovalConfig`)
- Gateway runtime state: `src/gateway/server-runtime-state.ts` (`pruneTimer` for rate limiter), `src/gateway/server-close.ts` (`pruneTimer` cleanup)
- HTTP wiring: `src/gateway/server-http.ts` (rate limiter creation with approval config)
- Agent tool: `src/agents/tools/gateway-security-tool.ts` (ban list, unban, password reset)
- System prompt: `src/agents/system-prompt.ts` (tool summary + dedicated section)
- Gateway methods: `src/gateway/server-methods.ts` (`gateway.security.bans.*` in admin methods)

Core invariants:
- `authorizeGatewayConnect()` returns `ok: false` for approval mode — the WS message handler approval bypass is the ACTUAL auth gate, not a redundant check. If `authorizeGatewayConnect` returns `ok: true` for approval mode, the WS bypass becomes dead code and ALL connections pass auth (security bug).
- The WS approval bypass requires valid device identity (`device && devicePublicKey`); anonymous connections cannot use approval mode.
- Rate limiting order in `/pair/request` is critical: check → record → read body → validate. `recordRequest()` MUST be called immediately after `checkRequest()` passes, BEFORE body read — this prevents request-flooding via slow body sends.
- Rate limiter has separated concerns: `recordRequest()`/`recordStatus()` manage cooldown + window counting; `track()`/`release()` manage in-flight pending count. These were separated to prevent `pendingCount` leaks and to avoid `/pair/status` polling from blocking new pairing requests.
- `/pair/status` has its own rate limit window with 3x the normal limit (default 30 req/60s vs 10 req/60s) to support 3-second polling without blocking.
- Ban persistence survives restarts (disk-backed at `<stateDir>/gateway/pair-bans.json`). Rate limiting is in-memory only (resets on restart).
- Ban is permanent until manual unban (no automatic expiry). Once banned (`bannedAt !== null`), `recordFailure()` is idempotent (doesn't increment count further).
- `bannedAt` is preserved on repeated failures (set once on threshold breach, not updated on subsequent calls).
- Ban records are validated on load: invalid entries are silently dropped.
- Password validation uses `safeEqual()` (constant-time comparison via `crypto.timingSafeEqual`) for both `/pair/request` and WS bypass paths — prevents timing attacks.
- Password absence determines auth mode: no password → LAN-only (skip password check); password present → WAN-safe (require password for pairing and WS bypass).
- Signature payload format: `${deviceId}:${signedAt}`. Clock skew tolerance: 60 seconds. Device ID derived from public key fingerprint (SHA256).
- Server-assigned defaults in `/pair/request` override client values: `role: "operator"`, `scopes: ["operator.admin"]`, `silent: false` (requires manual approval).
- Approval mode relaxes the non-loopback bind restriction — the gateway will bind externally without a shared secret when approval mode is configured. (`src/gateway/server-runtime-config.ts`)
- `pruneTimer` (rate limiter cleanup interval) is tracked in gateway runtime state and cleared on gateway shutdown to prevent timer leaks.
- Config schema uses `.strict()` on the approval object — unknown keys are rejected, preventing config typos from silently passing validation.
- `gateway_security` tool is main-agent-only (registered only when `agentId === DEFAULT_AGENT_ID`).
- Password reset via the tool writes to config and triggers gateway restart — active connections are dropped.
- IP validation (`isIP()`) is enforced before unban to prevent injection.
- Password constraints: min 8 chars, ASCII printable only (0x20-0x7E); empty password is valid (removes requirement).

Checklist:
1. If you change the auth resolution for approval mode, verify that `authorizeGatewayConnect()` still returns `ok: false` — returning `ok: true` makes the WS bypass dead code (critical security invariant).
2. If you change rate limiting, preserve the separated concerns (record vs track/release) and the check→record→body→validate order.
3. If you change ban management, preserve persistence, idempotency after ban, and `bannedAt` immutability after threshold breach.
4. If you change password handling, ensure `safeEqual()` is used in BOTH code paths (`pair-http.ts` and `message-handler.ts`) to prevent timing attacks.
5. If you change the pairing request flow, verify server-assigned defaults (role/scopes/silent) still override client values.
6. If you change the approval config schema, keep `.strict()` to prevent silent config typos.
7. If you change the rate limiter lifecycle, ensure `pruneTimer` is still tracked in runtime state and cleared on shutdown.
8. If you change the system prompt sections for gateway security, ensure they are gated on `availableTools.has("gateway_security")` and excluded in minimal/subagent mode.

Primary tests:
- `src/gateway/auth.test.ts` (approval mode auth resolution)
- No dedicated test files for pair-http, pair-rate-limit, or pair-ban. Consider adding:
  - `src/gateway/pair-rate-limit.test.ts` (layers, separation of concerns, window behavior)
  - `src/gateway/pair-ban.test.ts` (persistence, idempotency, validation on load)
  - `src/gateway/pair-http.test.ts` (request flow, password validation, signature verification)
  - `src/agents/tools/gateway-security-tool.test.ts` (IP validation, password constraints, config writes)

## Seam Coverage Status

All 25 seams have owner modules, core invariants, test citations, and a change checklist. All 4 supplemental playbooks (Add Gateway WS Method, Change WS Connect/Auth/Pairing, Add Channel Plugin, Add/Change Slash Command) have invariants and test pointers.

Per-provider playbooks are included under Channels+Delivery for all 6 core providers (WhatsApp/Web, Telegram, Discord, Slack, Signal, iMessage) and 6 extension channels (MS Teams, Voice Call, Google Chat, Matrix, LINE, Feishu). Memory extension playbooks (Memory-LanceDB, Memory-Core) are included under Memory+Search.

Remaining structural work:
- File-level deep reading (ongoing, tracked in `docs/architecture/reading-checklist.md`) — may refine existing seams but unlikely to produce new ones
