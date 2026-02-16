# OpenClaw Architecture Notes

This document describes the current architecture as implemented in this repository. It is intended as an engineering reference, with concrete pointers into the code.

For senior-dev change guidance (seams + playbooks), start with `docs/architecture/GUIDEBOOK.md`.

## 1. Components

- CLI (openclaw ...): parses commands, may talk to the Gateway via WebSocket RPC, may also start/manage the local Gateway service.
  Entry: src/entry.ts -> src/cli/run-main.ts

- Gateway (control plane): single WebSocket + HTTP server that multiplexes:
  - WebSocket RPC (methods + events)
  - Control UI (static assets + WebChat)
  - Hooks HTTP endpoints
  - Optional OpenAI-compatible endpoints
  - Node and channel ingress endpoints
  Entry: src/gateway/server.impl.ts (startGatewayServer)

- Channels: messaging surface adapters (Telegram, WhatsApp Web, Slack, Discord, Signal, iMessage, etc). In practice these are plugins shipped in extensions/*.
  Contract: src/channels/plugins/types.plugin.ts + src/channels/plugins/types.adapters.ts

- Embedded agent runtime: runs model calls, streams replies, executes tools, manages compaction, and emits events.
  Root: src/agents/

- Plugins: dynamic extension mechanism for channels, providers, tools, hooks, services, commands, and gateway methods.
  Root: src/plugins/

- Control UI: Vite + Lit app built to dist/control-ui and served by the Gateway.
  Root: ui/

- Nodes: companion devices (macOS/iOS/Android) that connect to the Gateway as role=node.
  Root: apps/ and src/gateway/node-registry.ts

## 2. Boot and Execution Flow

### 2.1 CLI boot

- openclaw.mjs loads dist/entry.js.
- dist/entry.js comes from src/entry.ts.
- src/entry.ts normalizes argv on Windows, applies --profile/--dev env defaults, and then calls runCli() from src/cli/run-main.ts.

CLI registration is lazy:
- src/cli/program/build-program.ts creates a Commander program and registers top-level commands.
- src/cli/program/register.subclis.ts lazily registers subcommands based on the primary command unless disabled.

There is also a fast path router:
- src/cli/route.ts tries to route certain commands before fully building the Commander program (status/health/sessions, etc).

### 2.2 Gateway boot

- Gateway is started by CLI subcommands (gateway run / daemon install/start/stop) and by packaged app flows.
- startGatewayServer (src/gateway/server.impl.ts) does:
  - Ensure OPENCLAW_GATEWAY_PORT is set
  - Read config snapshot, migrate legacy entries, validate
  - Auto-enable plugins (config mutation)
  - Load plugins, then merge gateway methods from core + channels/plugins
  - Resolve runtime config (bind host, auth, tailscale constraints, HTTP endpoints)
  - Create runtime state (HTTP servers, WebSocketServer, broadcaster, chat run buffers)
  - Apply command lane concurrency (cron/main/subagent)
    - src/gateway/server-lanes.ts + src/process/command-queue.ts
  - Start maintenance timers (tick, health refresh, dedupe cleanup, abort GC)
    - src/gateway/server-maintenance.ts
  - Start the heartbeat runner and wire heartbeat events into gateway presence/health surfaces
    - src/infra/heartbeat-runner.ts + src/infra/heartbeat-events.ts (subscribed from src/gateway/server.impl.ts)
  - Start discovery, sidecars (browser control, channels, hooks, plugin services), tailscale exposure
  - Attach WS handlers and method dispatch

Safety checks:
- src/gateway/server-runtime-config.ts refuses non-loopback bind unless a shared secret is configured.
- tailscale serve/funnel requires bind=loopback.

### 2.3 WebSocket connection and protocol

Handshake (server side):
- src/gateway/server/ws-connection.ts
  - Accepts the upgrade, assigns connId, sends connect.challenge with a nonce, starts a handshake timer, and wires close/error handling (presence + node cleanup).
- src/gateway/server/ws-connection/message-handler.ts
  - Requires the first client frame to be a valid request frame (type=req, method=connect, params=ConnectParams).
  - Negotiates protocol version via minProtocol/maxProtocol vs PROTOCOL_VERSION (closes with 1002 on mismatch).
  - Normalizes role to operator|node and defaults operator scopes to operator.admin when none are provided.
  - Browser clients (Control UI/WebChat) are gated by origin checks (gateway.controlUi.allowedOrigins).
  - Local client detection is cautious when proxy headers are present (gateway.trustedProxies influences whether a connection is treated as local).
  - Auth is enforced via src/gateway/auth.ts (token/password, optionally Tailscale) and returns a user-facing hint string on failure.
  - Device identity and pairing:
    - Non-local clients typically must provide a signed device identity; signatures include role/scopes and are nonce-bound unless local.
    - If the device is not paired (or needs a role/scope upgrade), the server issues a pairing request and fails the handshake with NOT_PAIRED plus a requestId.
    - Device identity signatures are Ed25519 and are verified via helpers in `src/infra/device-identity.ts` (clients load/create their local identity by default under `~/.openclaw/identity/device.json`).
    - Device pairing state (pending/paired + per-role auth tokens) is persisted under `<stateDir>/devices/{pending.json,paired.json}` via `src/infra/device-pairing.ts`; clients cache per-role tokens under `<stateDir>/identity/device-auth.json` via `src/infra/device-auth-store.ts`.
    - Node pairing uses a parallel store under `<stateDir>/nodes/{pending.json,paired.json}` via `src/infra/node-pairing.ts`.
  - On success, replies with hello-ok including: methods/events, a snapshot (presence + cached health), canvasHostUrl, and policy limits (max payload/buffer + tick interval).

Dispatch:
- src/gateway/server-methods.ts defines coreGatewayHandlers and enforces role/scope authorization.
- The protocol types and validators live in src/gateway/protocol/ (AJV + schemas).

Events:
- src/gateway/server-methods-list.ts defines GATEWAY_EVENTS.

### 2.4 Chat run and streaming

The Gateway maintains a mapping between:
- runId (agent run identifier)
- sessionKey (persistence key)
- clientRunId (for WebChat UI correlation)

Core pieces:
- chat methods: src/gateway/server-methods/chat.ts
- agent event -> chat event projection: src/gateway/server-chat.ts

### 2.5 Node lifecycle

- Nodes connect over WS as role=node.
- Node pairing and commands are managed by gateway methods in src/gateway/server-methods/nodes.ts.
- Live node state is tracked by src/gateway/node-registry.ts.
- Nodes can subscribe to chat events for a sessionKey (chat.subscribe/chat.unsubscribe) via server-node-events.ts.

### 2.6 Embedded Pi Agent Runtime (Pi)

The embedded agent runtime is OpenClaw's local execution engine used by:
- Gateway chat runs (WebChat, channel inbound messages, CLI chat)
- Cron isolated-agent runs

The Pi runtime is the @mariozechner/pi-* stack, wrapped by OpenClaw glue under `src/agents/`.

Core orchestration:
- `src/agents/pi-embedded-runner/run.ts`: outer orchestration with lane queueing (session lane + global lane), context-window guards, auth-profile selection/rotation, optional thinking-level downgrade retries, and optional model fallback via `FailoverError`.
- `src/agents/pi-embedded-runner/run/attempt.ts`: one concrete attempt. Sets up sandbox + workspace, skills env overrides, bootstrap context files, tools, system prompt, transcript hygiene, and executes the model prompt.
- `src/agents/pi-embedded-subscribe.ts` + `src/agents/pi-embedded-subscribe.handlers.*`: subscribes to session events and turns provider streams into:
  - partial assistant deltas (for UI)
  - block replies (for chat surfaces)
  - tool summaries/output (verbose modes)
  - reasoning streaming or reasoning-as-message (depending on `reasoningMode`)

Session lifecycle and persistence:
- `src/agents/pi-embedded-runner/session-manager-init.ts`: works around a SessionManager persistence quirk by resetting pre-created session files that have no assistant message so the first user turn is persisted.
- `src/agents/pi-embedded-runner/google.ts`: transcript hygiene pipeline used before prompts. It sanitizes images, optionally normalizes "antigravity" thinking signatures, repairs tool-call inputs and tool-use/result pairing, and applies a Google turn-ordering fix when needed.
- `src/agents/pi-embedded-runner/history.ts`: optional DM history limiting (per-provider + per-user overrides via config).

Tool construction and gating:
- `src/agents/pi-tools.ts`: builds the final tool list.
  - Always uses `customTools` (no built-in SDK tools) via `src/agents/pi-embedded-runner/tool-split.ts`.
  - Adds `exec` + `process` tools, channel docking tools, OpenClaw core tools, and (optionally) `apply_patch`.
  - Applies layered allow/deny policies (profile, byProvider profile, global allow, byProvider allow, agent allow, agent byProvider allow, group policy, sandbox policy, subagent policy).
  - Normalizes tool JSON schemas to avoid provider-rejected union schemas.

Prompt execution details worth keeping straight:
- Hooks: `run/attempt.ts` runs plugin hooks:
  - `before_agent_start` may prepend context to the prompt.
  - `agent_end` runs fire-and-forget to let plugins analyze conversations.
- Native images: `run/images.ts` detects local image references in the prompt and prior history; it loads them as base64 and injects history images back into their original message positions.
- Active run steering: `src/agents/pi-embedded-runner/runs.ts` tracks active runs and allows queueing/steering messages only while streaming and not compacting.

Compaction:
- `src/agents/pi-embedded-runner/compact.ts` runs session compaction in lanes, with the same bootstrap/tools/prompt setup as normal runs.
- `src/agents/pi-embedded-runner/run.ts` will attempt one auto-compaction on context overflow (but not on compaction failure), then retry the prompt.

### 2.7 Web Tools (web_fetch and web_search)

These tools provide lightweight web access without full browser automation.

- `web_fetch` (tool): `src/agents/tools/web-fetch.ts`
  - Fetches `http:`/`https:` URLs via `fetchWithSsrFGuard` (`src/infra/net/fetch-guard.ts` + `src/infra/net/ssrf.ts`).
  - SSRF protection blocks localhost/private IP literals and hostnames that resolve to private/internal IPs; DNS is pinned by default so redirects and subsequent requests cannot swap resolution.
  - Extraction:
    - If `content-type` is HTML, runs Readability extraction (`src/agents/tools/web-fetch-utils.ts`) and converts to markdown/text; if extraction yields empty text and Firecrawl is configured, falls back to Firecrawl.
    - If JSON, pretty-prints JSON when parseable.
    - Otherwise returns raw response text.
  - Security wrapping: returned `text` is wrapped as untrusted external content (`src/security/external-content.ts`). `url`/`finalUrl` are intentionally left raw for tool chaining.
  - `maxChars` enforcement happens after wrapping, so the returned payload always respects the caller's budget (even when wrapper overhead is large).

- `web_search` (tool): `src/agents/tools/web-search.ts`
  - Brave provider: returns result titles/snippets wrapped as untrusted external content; URLs are left raw for tool chaining.
  - Perplexity provider: calls a chat-completions compatible endpoint (direct Perplexity or via OpenRouter) and wraps synthesized content; citations are left raw for tool chaining.
  - Supports Brave `freshness` filtering (shortcut values and validated date ranges).

### 2.8 Node Tools (nodes and canvas)

These tools provide a high-level wrapper around Gateway node pairing and node.invoke commands.

- `nodes` (tool): `src/agents/tools/nodes-tool.ts`
  - Discovers nodes: `action=status` calls `node.list`. When node listing fails (older gateways or restricted scope), node selection helpers fall back to `node.pair.list` for paired nodes (`src/agents/tools/nodes-utils.ts`).
  - Pairing queue: `pending` (`node.pair.list`), `approve` (`node.pair.approve`), `reject` (`node.pair.reject`).
  - Notifications: `notify` invokes `system.notify` on the target node.
  - Device media capture:
    - `camera_snap` invokes `camera.snap` (format fixed to JPG in the tool), writes a temp file, and returns both `MEDIA:<path>` and an inline base64 image block. The tool sanitizes images in the tool result (`src/agents/tool-images.ts`).
    - `camera_clip` invokes `camera.clip` (mp4), writes a temp file, and returns `FILE:<path>`.
    - `screen_record` invokes `screen.record` (mp4), writes a temp file, and returns `FILE:<path>`.
  - Location: `location_get` invokes `location.get` and returns the payload as JSON.
  - Remote execution: `run` invokes `system.run` with `command` as argv array plus optional `cwd`/`env` and timeout controls. The tool injects the resolved `agentId` and the current `sessionKey` so the node can attribute the run.
  - Raw invoke: `invoke` exposes a generic `node.invoke` with JSON params.

- `canvas` (tool): `src/agents/tools/canvas-tool.ts`
  - Picks a default node when `node` is omitted (`resolveNodeId(..., allowDefault=true)`). Default selection prefers a single connected node; otherwise it prefers a single local macOS node (`nodeId` prefix `mac-`) when unambiguous (`src/agents/tools/nodes-utils.ts`).
  - `present`/`hide`/`navigate`/`eval`: wraps `canvas.*` node commands.
  - `snapshot`: invokes `canvas.snapshot`, writes a temp image file, and returns an image tool result.
  - `a2ui_push`/`a2ui_reset`: pushes JSONL UI events to the canvas host via `canvas.a2ui.*`.

### 2.9 Memory Tools (memory_search and memory_get)

OpenClaw has an optional "memory" subsystem (markdown files + embeddings index) that can be exposed as tools to the agent.

- `memory_search` (tool): `src/agents/tools/memory-tool.ts`
  - Enabled only when memory search is enabled for the agent (`src/agents/memory-search.ts`) and a memory manager is available (`src/memory/search-manager.ts`).
  - Executes a semantic search over `MEMORY.md` and `memory/*.md` (and optionally session transcripts, if enabled) and returns `path` + line ranges + snippet text (`src/memory/types.ts`).
  - Citations behavior:
    - Global `memory.citations` controls snippet decoration (`on`/`off`/`auto`).
    - `auto` includes citations in direct chats but suppresses them for group/channel session keys (derived from `sessionKey` tokens).
  - Backend selection:
    - `memory.backend=qmd` uses `QmdMemoryManager` when available and wraps it with an auto-fallback manager that switches to the builtin index on errors.
    - Otherwise uses the builtin `MemoryIndexManager`.

- `memory_get` (tool): `src/agents/tools/memory-tool.ts`
  - Reads a small snippet from a specific memory file path with optional `from` and `lines`, intended to keep context small after a `memory_search` hit.

### 2.10 Channel Action Tools (Telegram + Slack + Discord)

Some channels expose additional "message actions" beyond plain sendText/sendMedia (reactions, edits, deletes, stickers, etc).
These are surfaced through the generic messaging tool (`src/agents/tools/message-tool.ts`) and resolved by the shared outbound action runner (`src/infra/outbound/message-action-runner.ts`).

- Telegram actions handler: `src/agents/tools/telegram-actions.ts`
  - Supports: `sendMessage`, `editMessage`, `deleteMessage`, `react`, `sendSticker`, `searchSticker`, `stickerCacheStats`.
  - Gating:
    - Per-action gating via `channels.telegram.actions` (createActionGate).
    - Reactions are additionally gated by `channels.telegram.reactionLevel` (off/ack/minimal/extensive). Agent-controlled reactions require minimal/extensive; legacy `actions.reactions=false` is also respected.
    - Inline keyboard buttons are validated and capped (`callback_data` max 64 chars) and then gated by `channels.telegram.capabilities.inlineButtons` scope (off/dm/group/all/allowlist).
  - Token resolution supports default and per-account tokens from env/config/token files: `src/telegram/token.ts`.
  - Sends use grammY (`src/telegram/send.ts`) and handle:
    - Threading (forum topics + reply chaining),
    - Caption splitting for media + follow-up text,
    - HTML rendering with fallback to plain text on parse errors,
    - Optional proxy/network settings per account,
    - Activity logging and sent-message tracking.

- Slack actions handler: `src/agents/tools/slack-actions.ts`
  - Supports: `sendMessage`, `editMessage`, `deleteMessage`, `readMessages`, `react`, `reactions` (list), pin/unpin/listPins, memberInfo, emojiList.
  - Token selection: chooses bot vs user token based on operation (read vs write) and `userTokenReadOnly` (default: prefer bot for writes). Account config is merged from channel-level + per-account overrides (`src/slack/accounts.ts`).
  - Auto-threading: if the outbound tool context provides `currentChannelId` + `currentThreadTs`, `sendMessage` can auto-inject `threadTs` depending on `replyToMode` (off/first/all).
  - Implements actions via Slack Web API (`src/slack/actions.ts`) and message sends via `src/slack/send.ts` (uploads media via `files.uploadV2`, chunks long markdown into Slack mrkdwn, supports `thread_ts`).

- Discord actions handler: `src/agents/tools/discord-actions.ts` (+ `src/agents/tools/discord-actions-*.ts`)
  - Dispatches Discord "actions" into four clusters: messaging, guild, moderation, and presence.
  - Messaging actions include: message CRUD, reactions add/remove/list, stickers, polls, fetch/read/search, thread create/list/reply, pins, and channel permissions fetch (implemented via `src/discord/send.ts`).
  - Guild actions include: member/role/channel info, emoji/sticker upload, channel/category create/edit/move/delete, channel permission overwrites, voice status, and scheduled events (implemented via `src/discord/send.ts`; presence enrichment via `src/discord/monitor/presence-cache.ts`).
  - Presence action `setPresence` updates the active bot gateway presence via the Carbon gateway plugin and requires a connected gateway in the in-process gateway registry (`src/discord/monitor/gateway-registry.ts`).
  - Some higher-risk capabilities are default-off unless explicitly enabled in `channels.discord.actions`:
    - moderation (`timeout`, `kick`, `ban`) uses `defaultValue=false`
    - role changes (`roleAdd`, `roleRemove`) use `defaultValue=false`
    - presence updates (`setPresence`) use `defaultValue=false`
  - Read payloads normalize timestamps into `timestampMs` + `timestampUtc` when Discord APIs return timestamp strings (via `src/agents/date-time.ts`).
  - Discord outbound send behavior (used by actions and by the shared outbound layer):
    - Recipient parsing supports explicit `user:<id>` and `channel:<id>`. Bare numeric ids are rejected as ambiguous unless a default kind is provided by the caller (src/discord/targets.ts, src/discord/send.shared.ts).
    - Sending to users creates/uses a DM channel via `/users/@me/channels` (src/discord/send.shared.ts).
    - Text is chunked to Discord's 2000 char limit with a soft line cap (default 17) while balancing fenced code blocks and reasoning italics across chunk boundaries (src/discord/chunk.ts).
    - On missing permissions (Discord API code 50013), send errors attempt to compute which permissions are missing in the channel and surface a targeted hint (src/discord/send.shared.ts, src/discord/send.permissions.ts).

- WhatsApp actions handler: `src/agents/tools/whatsapp-actions.ts`
  - Currently supports reactions (`action=react`) gated by `channels.whatsapp.actions.reactions`.
  - Implementation uses the WhatsApp Web outbound adapter (`src/web/outbound.ts`) which requires an in-process "active web listener" to be registered for the target account (src/web/active-listener.ts).
  - The active listener is installed/removed by the WhatsApp Web monitor loop (src/web/auto-reply/monitor.ts) when the web session connects/disconnects.

## 3. Configuration and State

Config:
- src/config/paths.ts: resolve state dir and config path.
- src/config/io.ts: JSON5 parsing, includes, env substitution, validation, defaults.
- src/config/validation.ts: validates base schema and plugin-related constraints.

State:
- stateDir is used for sessions, credentials, caches.
- Gateway snapshot surfaces configPath and stateDir for UIs (src/gateway/server/health-state.ts).

## 4. Routing and Session Keys

- Routing selects agentId and sessionKey based on bindings and message metadata:
  src/routing/resolve-route.ts

- Session key format helpers:
  src/routing/session-key.ts and src/sessions/session-key-utils.ts

- Session-level send allow/deny policy:
  src/sessions/send-policy.ts

Sessions tooling (agent tools that operate on sessions via Gateway RPC):
- `sessions_list`, `sessions_history`, `sessions_send`, and `sessions_spawn` live under `src/agents/tools/` and call `sessions.*`, `chat.history`, `agent`, `agent.wait`, and sometimes `send`.
- Cross-agent visibility for list/history/send is governed by `tools.agentToAgent.*` (not by subagent allowlists).
- `sessions_spawn` creates a subagent session key `agent:<targetAgentId>:subagent:<uuid>`, runs the child in lane `subagent` with `deliver=false`, then announces results back to the requester via `src/agents/subagent-registry.ts` + `src/agents/subagent-announce.ts` (with optional steering/queueing when the requester session is active).

## 5. Plugins (extensions/*)

Discovery:
- src/plugins/discovery.ts searches:
  - config-specified plugin paths
  - workspace .openclaw/extensions
  - global config dir extensions
  - bundled extensions/ next to the package
- Discovery order defines precedence for duplicate ids: config > workspace > global > bundled. The first discovered plugin id wins; later duplicates are recorded as disabled with an override error (src/plugins/loader.ts).
- Candidate discovery supports:
  - single-file extensions (alpha.ts)
  - package directories with `package.json` `openclaw.extensions` entrypoints (packs), where id hints prefer the unscoped npm name and include a suffix when multiple entrypoints exist (src/plugins/discovery.ts).

Manifest:
- openclaw.plugin.json must exist and contain id + configSchema.
- package.json can also contain "openclaw" metadata used for onboarding/catalog.
- openclaw.plugin.json is loaded per rootDir (src/plugins/manifest.ts) and is cached briefly (default 200ms) to reduce repeated FS stats during reloads (src/plugins/manifest-registry.ts).
- The config schema is treated as JSON Schema and validated with AJV (src/plugins/schema-validator.ts). Invalid plugin config fails the plugin load early (plugin record status "error").

Loading:
- src/plugins/loader.ts uses jiti and aliases openclaw/plugin-sdk to the core implementation.
- Plugin enablement rules (src/plugins/config-state.ts):
  - `plugins.enabled=false` disables all plugins.
  - denylist wins over allowlist.
  - bundled plugins are disabled by default (even if allowlisted) unless explicitly enabled via `plugins.entries.<id>.enabled=true`, except for the active memory slot.
  - non-bundled plugins (config/workspace/global) are enabled by default unless disabled in config.
- Exclusive slots:
  - Default memory slot is `memory-core` unless overridden (or set to `"none"` to disable) (src/plugins/slots.ts, src/plugins/config-state.ts).
  - Only one memory plugin is enabled at a time; the memory slot selection disables other `kind="memory"` plugins (src/plugins/loader.ts).
- Plugin module loading:
  - Entry points are loaded via jiti from the discovered candidate `source`.
  - `openclaw/plugin-sdk` is aliased to either `src/plugin-sdk/index.ts` (dev) or `dist/plugin-sdk/index.js` (production), when present (src/plugins/loader.ts).
  - Plugin exports may be either a function (treated as `register`) or an object with `register`/`activate` (src/plugins/loader.ts).
  - If `register` returns a Promise, it is intentionally ignored and a warning diagnostic is emitted. Plugin registration must be synchronous (src/plugins/loader.ts).

Registry:
- src/plugins/registry.ts stores channel registrations, tool factories, hooks, gateway handlers, HTTP handlers/routes, CLI registrars, and services.
- The registry enforces:
  - gateway method uniqueness (cannot override core methods or other plugin methods) (src/plugins/registry.ts).
  - HTTP route path normalization and uniqueness (src/plugins/http-path.ts, src/plugins/registry.ts).
  - provider id uniqueness across plugins (src/plugins/registry.ts).
  - plugin command uniqueness and reserved-name blocking (src/plugins/commands.ts).
- Plugin tool registration supports optional tools: optional tools are only exposed when explicitly allowlisted by tool name, plugin id, or `group:plugins` (src/plugins/tools.ts).

Hook execution (typed lifecycle hooks):
- Plugins can register typed lifecycle hooks via `api.on(hookName, handler, { priority })` (src/plugins/types.ts).
- Hook runner semantics (src/plugins/hooks.ts):
  - "void" hooks run in parallel (fire-and-forget); errors are logged by default (catchErrors=true).
  - modifying hooks run sequentially in priority order; later handlers may override earlier values (merge function prefers `next.*` when present).
  - `tool_result_persist` is synchronous; async handlers (Promise return) are ignored with a warning.

Plugin commands (bypass agent):
- Plugins can register `/command` handlers via `api.registerCommand(...)` (src/plugins/types.ts, src/plugins/registry.ts).
- Commands are matched before built-in commands and before agent invocation (src/plugins/commands.ts, src/auto-reply/reply/commands-plugin.ts).
- Command name rules:
  - must be `^[a-z][a-z0-9_-]*$`
  - cannot override a reserved built-in command name list
  - if `acceptsArgs` is false and the user provides args, the command intentionally does not match (falls through)
  - args are sanitized (control chars stripped, length capped) and authorization is enforced by default (`requireAuth` defaults to true) (src/plugins/commands.ts).

Plugin services:
- Plugins can register background services (`api.registerService`) which are started on gateway startup and stopped on shutdown in reverse registration order (src/plugins/services.ts, src/gateway/server-startup.ts).

Plugin install/update:
- Plugins can be installed from a file/dir/archive/npm spec. Package installs require `package.json` to contain `openclaw.extensions` and install into `~/.openclaw/extensions/<pluginId>` (or configured state dir). If the plugin has runtime deps, install runs `npm install --omit=dev` in the plugin dir (src/plugins/install.ts).
- Update support tracks installs in config (`plugins.installs`) and supports switching installs between bundled local paths (dev channel) and npm installs (stable/beta) (src/plugins/update.ts).

## 6. Channels

Core channel ids and meta live in src/channels/registry.ts.

Channel plugin contract is in:
- src/channels/plugins/types.plugin.ts
- src/channels/plugins/types.adapters.ts

Bundled channels are implemented as extensions:
- extensions/<channel>/index.ts registers api.registerChannel({ plugin, dock? })
- extensions/<channel>/src/channel.ts implements the ChannelPlugin adapter

Most channel plugins delegate operational work to the PluginRuntime (openclaw/plugin-sdk), which exposes shared core implementations from the main src tree.

Example (Telegram bundled channel):
- extensions/telegram/index.ts sets the PluginRuntime into a module-local getter (extensions/telegram/src/runtime.ts) and registers `telegramPlugin`.
- extensions/telegram/src/channel.ts builds a `ChannelPlugin` by delegating message sends, probing, monitoring, audits, and message actions to runtime functions (e.g. `runtime.channel.telegram.sendMessageTelegram`, `runtime.channel.telegram.monitorTelegramProvider`, and `runtime.channel.telegram.messageActions.*`).

## 7. Tooling, Sandbox, and Approvals

Tool list construction:
- `src/agents/pi-tools.ts` is the canonical tool list builder used for Pi embedded runs.
- It starts from `@mariozechner/pi-coding-agent` coding tools, then:
  - wraps/normalizes `read`, `write`, `edit` for provider compatibility
  - adds OpenClaw tools (`src/agents/openclaw-tools.ts`) and channel docking tools
  - adds `exec` + `process` tools (`src/agents/bash-tools.*`)
  - optionally adds `apply_patch` (OpenAI providers only; model allowlist + config gated)

Policy layering:
- Tool allow/deny is applied in ordered layers in `src/agents/pi-tools.ts`:
  - tools.profile
  - tools.byProvider.profile
  - tools.allow
  - tools.byProvider.allow
  - agents.<id>.tools.allow
  - agents.<id>.tools.byProvider.allow
  - group policy (channel/group-specific)
  - sandbox tool policy (when sandboxed)
  - subagent policy (when sessionKey indicates a subagent)

Sandboxing (Docker + optional sandboxed browser):
- The sandbox is resolved per session via `resolveSandboxRuntimeStatus` and `resolveSandboxContext`:
  - `src/agents/sandbox/runtime-status.ts`: decides whether a session is sandboxed.
    - mode: off | non-main | all
    - non-main: sandbox all sessions except the agent's main session key
  - `src/agents/sandbox/context.ts`: ensures the sandbox workspace exists, ensures the Docker container exists/runs, and (optionally) ensures a sandboxed browser container + bridge.

Sandbox workspace rules:
- `src/agents/sandbox/workspace.ts` seeds the sandbox workspace with the agent workspace bootstrap files if missing, then calls `ensureAgentWorkspace`.
- If the sandbox workspace is separate from the agent workspace and access is not rw, OpenClaw attempts to sync skills into the sandbox workspace (`src/agents/skills.ts` via `syncSkillsToWorkspace`).

Docker container lifecycle and drift:
- `src/agents/sandbox/docker.ts` creates a container named from `containerPrefix + slugifySessionKey(scopeKey)`.
- A config hash (`src/agents/sandbox/config-hash.ts`) is computed from docker config + workspaceAccess + workspace paths.
  - If the hash mismatches and the container is "hot" (recently used and running), the container is not force-removed; instead OpenClaw logs a recreate hint (`openclaw sandbox recreate ...`).
  - Otherwise, it removes and recreates the container.
- Registry files persist container metadata for pruning and reporting:
  - `src/agents/sandbox/registry.ts`
  - `src/agents/sandbox/prune.ts` (idle/max-age cleanup)
  - `src/agents/sandbox/manage.ts` (list/remove)

Sandbox browser container:
- `src/agents/sandbox/browser.ts` starts a dedicated browser container, publishes CDP (and optionally noVNC) to loopback, and starts a browser bridge server.
- Browser enablement is gated both by `cfg.browser.enabled` and sandbox tool policy (must allow `browser`).

Sandbox tool policy (separate from global tool policy):
- `src/agents/sandbox/tool-policy.ts` resolves an allow/deny list for sandboxed sessions, sourced from:
  - agent-specific (`agents.list[].tools.sandbox.tools.*`)
  - global (`tools.sandbox.tools.*`)
  - or defaults (`src/agents/sandbox/constants.ts`)
- Deny takes precedence over allow; allow entries support `*` wildcards.
- `formatSandboxToolPolicyBlockedMessage` (`src/agents/sandbox/runtime-status.ts`) produces actionable CLI guidance.

Tool policy semantics (beyond layering):
- `src/agents/tool-policy.ts` defines canonical tool names, small aliasing (bash -> exec), and stable tool groups (group:fs, group:runtime, group:sessions, group:openclaw, etc.).
- Tool profiles (minimal/coding/messaging/full) are allowlists expressed in terms of groups.
- `tools.alsoAllow` is treated as additive. If no explicit allowlist exists, alsoAllow implies an allow-all baseline plus the listed entries.

Provider- and context-specific policy resolution:
- `src/agents/pi-tools.policy.ts` resolves policies from global + agent + provider-specific config (by provider id or full provider/model key).
- Group tool policy is resolved when a groupId can be inferred (explicit groupId or derived from sessionKey/spawnedBy) and can come from:
  - channel dock overrides (`getChannelDock(channel).groups.resolveToolPolicy`), or
  - generic group-policy config (`resolveChannelGroupToolsPolicy`).
- Subagent policy is a separate deny list (`resolveSubagentToolPolicy`) intended to keep orchestration and admin actions in the parent agent.

Allow/deny matching details:
- Allow/deny entries support `*` wildcards. Deny always wins.
- There is a special-case mapping: if `exec` is allowed, `apply_patch` is treated as allowed as well (so exec allowlists do not accidentally strand patching).
- Plugin-only allowlists are guarded: if an allowlist contains only plugin tools, the allowlist is stripped to avoid disabling core tools. Users who want additive plugin enablement should prefer `tools.alsoAllow`.

Schema normalization for provider quirks:
- `src/agents/pi-tools.schema.ts` normalizes tool JSON Schemas to be portable across providers.
  - OpenAI requires top-level `type: "object"` for function tool schemas.
  - Some providers reject top-level unions, so `anyOf`/`oneOf` variants are flattened into an object schema by merging properties (including enum merging for action-like fields).
- `src/agents/schema/clean-for-gemini.ts` scrubs Gemini/Cloud Code Assist-incompatible keywords, resolves local $ref/$defs, and simplifies unions (including stripping null variants and flattening literal anyOf to enums).
- `src/agents/pi-tools.read.ts` patches read/write/edit schemas for Claude Code parameter aliases and normalizes incoming params (file_path/old_string/new_string) to the internal conventions.

## 8. Control UI

- UI is built from ui/ to dist/control-ui.
- Served by the Gateway with anti-clickjacking headers: src/gateway/control-ui.ts
- Base path normalization: src/gateway/control-ui-shared.ts

## 9. Extension Inventory (Bundled)

Bundled plugins live under extensions/* and include:
- Channels: bluebubbles, discord, feishu, googlechat, imessage, line, matrix, mattermost, msteams, nextcloud-talk, nostr, signal, slack, telegram, tlon, twitch, whatsapp, zalo, zalouser
- Providers/auth helpers: copilot-proxy, google-antigravity-auth, google-gemini-cli-auth, minimax-portal-auth, qwen-portal-auth
- Memory: memory-core, memory-lancedb
- Services/tools: diagnostics-otel, llm-task, lobster, voice-call, open-prose (skills only)

## 10. Outbound Messaging and Mirroring

This is the core shared layer behind CLI message send, agent tool messaging, cron isolated delivery, and cross-session mirroring.

Key entrypoints:
- src/infra/outbound/message-action-runner.ts: canonical runner for channel message actions (send/poll/thread actions/etc).
- src/infra/outbound/message.ts: CLI-focused sendMessage/sendPoll wrapper; uses direct delivery when possible or gateway RPC when the plugin requires it.
- src/infra/outbound/deliver.ts: low-level delivery for ReplyPayload[] using channel outbound adapters (chunking + media sends) and optional transcript mirroring.

Targets and directory resolution:
- src/infra/outbound/targets.ts
  - Resolves implicit delivery from session context (lastChannel/lastTo) and explicit channel/to overrides.
  - Resolves heartbeat delivery targets, including allowFrom fallback and accountId validation.
- src/infra/outbound/target-resolver.ts
  - Converts human inputs (names, handles, channels) into stable provider ids, optionally using a cached directory lookup.
  - Heuristics avoid directory lookup when the input looks like an id; iMessage-like channels special-case phone numbers.
- src/infra/outbound/outbound-session.ts
  - Builds outbound session keys that align with inbound routing (Slack threads, Telegram topics, WhatsApp group jids, BlueBubbles group ids, identity links, etc).
  - Best-effort writes session meta so future runs can infer delivery context.

Cross-context policy and decoration:
- src/infra/outbound/outbound-policy.ts
  - Enforces cross-context send policy using toolContext.
  - Optionally decorates cross-context sends with a marker prefix/suffix or embeds (Discord).

Delivery + mirroring mechanics:
- src/infra/outbound/deliver.ts
  - Normalizes ReplyPayloads (reply directives, MEDIA tags) and sends via the channel plugin outbound adapter.
  - Chunking is adapter-driven; newline chunk mode exists for channels that prefer paragraph boundaries.
  - Signal is special-cased to convert markdown to styled plain text chunks and enforce max media bytes.
  - If mirror is set and at least one payload was sent, it appends an assistant transcript entry to the mirrored session key.

Attachments and tool params hydration:
- src/infra/outbound/message-action-runner.ts
  - Hydrates sendAttachment and setGroupIcon params by loading media/path/filePath into base64 buffer, inferring filename, and preserving contentType.
  - Supports Slack auto-thread mirroring using toolContext.currentThreadTs when reply-to mode indicates thread replies.
