# Gateway (Control Plane)
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Gateway Boot (Runtime Wiring), Gateway Protocol + Schemas, Security + Audit

- Port: 18789 by default
- Transport: WebSocket (ws:// or wss://) and HTTP on the same port

Implementation:
- Server bootstrap: src/gateway/server.impl.ts (startGatewayServer)
- Runtime config resolution: src/gateway/server-runtime-config.ts
- HTTP multiplexer: src/gateway/server-http.ts
- WS connection + handshake: src/gateway/server/ws-connection.ts + src/gateway/server/ws-connection/message-handler.ts
- Method dispatch + auth/scopes: src/gateway/server-methods.ts
- Methods list + events list: src/gateway/server-methods-list.ts

Protocol schemas and validation:
- Protocol version constant: `PROTOCOL_VERSION` is defined in `src/gateway/protocol/schema/protocol-schemas.ts` (current value: 3).
- Type schemas are defined with TypeBox under `src/gateway/protocol/schema/*` and re-exported via `src/gateway/protocol/schema.ts`.
- Runtime request/response validation uses AJV compilers in `src/gateway/protocol/index.ts` (e.g. `validateConnectParams`, `validateRequestFrame`).

Gateway boot (what actually happens at startup):
- `startGatewayServer(port, opts)` (`src/gateway/server.impl.ts`):
  1. Sets `OPENCLAW_GATEWAY_PORT` so default port derivations (browser/canvas) match runtime.
  2. Reads a config snapshot.
  3. If `legacyIssues` exist:
     - In Nix mode, it errors (no auto-migration allowed).
     - Otherwise it calls `migrateLegacyConfig(snapshot.parsed)` and writes the migrated config to disk (`writeConfigFile`), then re-reads snapshot.
  4. If config exists and is invalid, it errors with a `openclaw doctor` hint.
  5. Applies plugin auto-enable (`applyPluginAutoEnable`) and best-effort persists via `writeConfigFile`.
  6. Loads live config via `loadConfig()` (note: `loadConfig()` itself does not write migrations).
  7. Loads gateway plugins (`loadGatewayPlugins`) and merges gateway methods:
     - Base methods from `listGatewayMethods()` (`src/gateway/server-methods-list.ts`)
     - Plugin-provided methods (from loaded gateway plugins and from channel plugins `plugin.gatewayMethods`)
  8. Resolves runtime config (`resolveGatewayRuntimeConfig`), including bind host, auth, tailscale constraints, endpoint flags, hooks config, and canvas host enablement.
  9. Resolves the Control UI root:
     - If `gateway.controlUi.root` is set, it is treated as an override and validated.
     - Otherwise, if Control UI is enabled, it attempts to locate built assets and can trigger an on-demand build (`ensureControlUiAssetsBuilt`) before retrying.
  10. Creates runtime state (`createGatewayRuntimeState`):
      - HTTP server(s) (one per resolved listen host, typically loopback aliases) + shared `WebSocketServer` with `noServer=true`
      - broadcaster + client set
      - chat run registries and abort controllers
      - optional canvas host mounted under the canvas base path
  11. Starts discovery (mdns/wide area) and maintenance timers.
  12. Starts cron + heartbeat runner and wires their events into gateway broadcasts.
  13. Attaches WS handlers (`attachGatewayWsHandlers`) with the method/event list and merged handler set (core + plugins + exec approvals).
  14. Starts tailscale exposure (serve/funnel) when configured.
  15. Starts sidecars (`startGatewaySidecars`): browser control, gmail watcher, internal hooks, channels, plugin services.
  16. Starts config reload watcher (`startGatewayConfigReloader`) to hot-reload or restart on config changes.

Gateway HTTP routing (first match wins):
- `createGatewayHttpServer()` (`src/gateway/server-http.ts`) handles HTTP requests in this order:
  1. hooks
  2. tools invoke HTTP
  3. slack HTTP ingress
  4. plugin HTTP handlers
  5. OpenResponses `/v1/responses` (optional)
  6. OpenAI-compatible `/v1/chat/completions` (optional)
  7. canvas host + a2ui endpoints (optional)
  8. Control UI assets + avatar endpoint (optional)
  9. otherwise 404
- WebSocket upgrades are not processed by the HTTP handler; the `upgrade` event is attached in `attachGatewayUpgradeHandler()`. The canvas host can intercept upgrades before the gateway WS server.

Gateway config reload (file watcher):
- `startGatewayConfigReloader()` (`src/gateway/config-reload.ts`) watches the config path with `chokidar`, diffs `currentConfig` to `nextConfig`, and builds a reload plan.
- `gateway.reload.mode`:
  - `off`: logs and does nothing.
  - `restart`: queues a single restart on first change.
  - `hot`: applies hot reload actions only; if restart is required, logs and ignores.
  - `hybrid`: hot reload when possible, restart when required.
- Reload rules are path-prefix based and channel plugins can contribute prefixes (hot or noop) via `plugin.reload`.

Key concepts:
- Roles: operator vs node. Method authorization is scope-based (operator.read/operator.write/operator.admin, plus operator.approvals/operator.pairing). Nodes can only call a small set of node-scoped methods.
- The Gateway broadcasts events like presence, health, chat deltas/finals, node pairing state, exec approvals, etc.
- The Gateway also hosts optional HTTP endpoints:
  - Control UI static assets (dist/control-ui; generated by `pnpm ui:build`)
  - /v1/chat/completions (OpenAI compatible) when enabled
  - /v1/responses (OpenResponses) when enabled
  - Tool invoke HTTP endpoints
  - Hooks endpoints under a configured base path
  - Some channel HTTP ingress (Slack, Google Chat) and plugin HTTP handlers

Device identity + pairing (Gateway WS clients):
- Device identity keys (`src/infra/device-identity.ts`):
  - Each client has an Ed25519 keypair. The `deviceId` is `sha256(publicKeyRaw)` (hex), where `publicKeyRaw` is either the 32-byte Ed25519 key material (preferred) or the full SPKI DER when parsing fails.
  - The default identity file path is `~/.openclaw/identity/device.json` (this default does not consult `OPENCLAW_STATE_DIR`).
  - Public keys are accepted as either PEM (`-----BEGIN PUBLIC KEY-----`) or raw base64url; helpers normalize both to base64url and can derive `deviceId` from either.
  - Signatures are emitted as base64url; verification accepts base64url (preferred) and falls back to base64 decoding for compatibility.
- Device auth token cache (client side): `src/infra/device-auth-store.ts`
  - Stores `{ token, role, scopes[], updatedAtMs }` under `<stateDir>/identity/device-auth.json`, keyed by `role`, and scoped to a single `deviceId` (mismatch clears the cache path for that identity).
- Operator/device pairing store (server side): `src/infra/device-pairing.ts`
  - Persists pending and paired devices under `<stateDir>/devices/{pending.json,paired.json}`. Pending requests expire after 5 minutes.
  - `requestDevicePairing` is idempotent per `deviceId` while pending: it reuses the existing request and returns `created=false`.
  - Approval creates or rotates a per-role auth token (random uuid without dashes) and records role scopes on the token entry; token verification checks role + token + scope subset and updates `lastUsedAtMs`.
  - Token operations support: ensure (create if missing or insufficient scopes), rotate (optionally changing scopes), and revoke (sets `revokedAtMs`).
- Node pairing store (server side): `src/infra/node-pairing.ts`
  - Similar to device pairing, but stored under `<stateDir>/nodes/{pending.json,paired.json}` with a single token per nodeId and pending TTL of 5 minutes.
  - Paired node metadata can be patched, and display names can be renamed with validation.
- Single-gateway lock: `src/infra/gateway-lock.ts`
  - Uses a per-config lock file `gateway.<sha1(configPath)[:8]>.lock` under `resolveGatewayLockDir()`. Lock payload includes `{ pid, createdAt, configPath, startTime? }`.
  - On Linux, `startTime` (from `/proc/<pid>/stat`) is used to treat recycled PIDs as dead; otherwise it attempts to validate that the PID argv looks like an OpenClaw gateway process.
  - If owner status is unknown, the lock is only removed when stale (by payload timestamp, lock mtime, or missing stat).
