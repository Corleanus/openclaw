# Nodes (Companion Apps)
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Nodes (Device Boundary)

Nodes are "device boundary" clients that connect to the Gateway as role=node. They provide device-local capabilities (canvas, camera, screen recording, location, SMS, system exec, etc) to the agent/tooling via a single RPC/event contract.

This section focuses on the cross-cutting on-wire contract and the invariants that must remain stable across:
- gateway (TypeScript)
- node-host (TypeScript)
- macOS app
- iOS app
- Android app

### Gateway Contract

Role + method gating:
- role=node may only call `node.invoke.result`, `node.event`, and `skills.bins`. (`src/gateway/server-methods.ts`)
- All other methods are operator-only; nodes cannot call them.

Node identity:
- `nodeId` used throughout the Gateway node APIs is `connect.device.id` (device identity), not `connect.client.instanceId`. (`src/gateway/node-registry.ts`, `src/gateway/client.ts`)
- On connect, the gateway records "last connected" metadata for both the device-id nodeId and the client instanceId (when present) to preserve older pairing keys. (`src/gateway/server/ws-connection/message-handler.ts`)

Listing and pairing:
- `node.list` merges:
  - paired node entries from the device pairing store (`listDevicePairing()` filtered to role=node), and
  - live connected nodes from `NodeRegistry.listConnected()`.
  It normalizes and sorts so connected nodes appear first. (`src/gateway/server-methods/nodes.ts`)
- Pairing is managed via `node.pair.*`:
  - `node.pair.request` creates a pending request and broadcasts `node.pair.requested` when newly created.
  - `node.pair.approve` and `node.pair.reject` broadcast `node.pair.resolved`.
  - `node.pair.verify` verifies a node token. (`src/gateway/server-methods/nodes.ts`, `src/infra/node-pairing.ts`, `src/gateway/server-broadcast.ts`)

Invoke flow (operator -> node):
1. Operator calls `node.invoke` with `{ nodeId, command, params?, timeoutMs?, idempotencyKey }`. (`src/gateway/server-methods/nodes.ts`, `src/gateway/protocol/schema/nodes.ts`)
2. Gateway enforces command policy:
   - command must be in the platform allowlist (`resolveNodeCommandAllowlist`)
   - node must have declared the command in `connect.commands`
   If the node does not declare commands, nothing is invokable. (`src/gateway/node-command-policy.ts`)
3. Gateway sends a node event `node.invoke.request` with payload:
   `{ id, nodeId, command, paramsJSON?, timeoutMs?, idempotencyKey? }`.
   `paramsJSON` is produced by JSON-stringifying the operator's `params`. (`src/gateway/node-registry.ts`)
4. Node responds with RPC `node.invoke.result` echoing `id` and `nodeId`.
   - `nodeId` mismatches are rejected.
   - Late/unknown results (after timeout) are treated as success but returned with `{ ignored: true }` to avoid log spam. (`src/gateway/server-methods/nodes.ts`, `src/gateway/server.nodes.late-invoke.test.ts`)
5. Gateway resolves `node.invoke` with either parsed `payload` (from `payloadJSON`) or raw `payload` passthrough. (`src/gateway/server-methods/nodes.ts`)

Event flow (node -> gateway):
- Nodes send `node.event` with `{ event, payloadJSON? }` (or `payload`, which is JSON-stringified server-side). (`src/gateway/server-methods/nodes.ts`, `src/gateway/protocol/schema/nodes.ts`)
- The gateway only processes a small allowlisted set of node-originated events; others are ignored:
  - `voice.transcript`: expects payloadJSON `{"text": "...", "sessionKey"?: "..."}`; runs `agentCommand` with `deliver: false`, defaulting `sessionKey` to `cfg.session.mainKey` when absent. It also registers a synthetic chat run so UI clients refresh when the run completes. (`src/gateway/server-node-events.ts`)
  - `agent.request`: expects an "agent deep link" JSON (message, sessionKey, thinking, deliver, channel, to, timeoutSeconds, key). It defaults `sessionKey` to `node-<nodeId>` and only delivers when `deliver=true` and `channel` resolves. (`src/gateway/server-node-events.ts`)
  - `chat.subscribe` / `chat.unsubscribe`: payloadJSON `{"sessionKey":"..."}`; maintains a node<->session subscription map used to forward chat/agent events to nodes. (`src/gateway/server-node-subscriptions.ts`, `src/gateway/server-node-events.ts`)
  - `exec.started` / `exec.finished` / `exec.denied`: payloadJSON is treated as best-effort; the gateway emits a system event and triggers a heartbeat to surface the result quickly. (`src/gateway/server-node-events.ts`, `src/gateway/server-node-events.test.ts`)
- Node subscriptions are cleared on node disconnect (`nodeUnsubscribeAll`), triggered by the WS connection close handler. (`src/gateway/server/ws-connection.ts`)

Node command allowlist defaults (gateway):
- `src/gateway/node-command-policy.ts` defines the platform default allowlist:
  - iOS: `canvas.*`, `camera.*`, `screen.record`, `location.get`
  - Android: iOS defaults + `sms.send`
  - macOS: iOS defaults + `system.run`, `system.which`, `system.notify`, `system.execApprovals.get/set`, `browser.proxy`
  - Linux/Windows: system commands + `browser.proxy`
  - unknown: superset (includes SMS + system)
- Config can widen/narrow this via `gateway.nodes.allowCommands` and `gateway.nodes.denyCommands`, but declared commands still apply.

### Node Host (src/node-host)

The node-host is a headless node implementation (useful for desktop/headless environments) that connects as role=node and handles `node.invoke.request`. (`src/node-host/runner.ts`)

Declared caps/commands:
- caps: `["system"]` (+ `["browser"]` when browser proxy is enabled)
- commands:
  - `system.run`
  - `system.which`
  - `system.execApprovals.get`
  - `system.execApprovals.set`
  - `browser.proxy` (optional)

Security invariants:
- Environment overrides are sanitized:
  - blocks `NODE_OPTIONS` and other language runtime injection keys, plus `DYLD_*` and `LD_*`.
  - `PATH` overrides are only accepted if they preserve the base PATH as a suffix (prevents "replace PATH with malicious bins"). (`src/node-host/runner.ts`)
- Output caps:
  - total stdout/stderr capture is capped (`OUTPUT_CAP=200_000`)
  - exec event output is tailed (`OUTPUT_EVENT_TAIL=20_000`) (`src/node-host/runner.ts`)
- Browser proxy file attachments:
  - reads files referenced by proxy responses (`path`, `imagePath`, or `download.path`)
  - caps each file to 10MB and attaches base64 + detected MIME (`detectMime`). (`src/node-host/runner.ts`, `src/media/mime.ts`)

Exec approvals:
- `system.run` uses the shared exec approvals model (`src/infra/exec-approvals.ts`) and emits `exec.*` node events.
- On macOS, it can delegate execution to the companion app exec host over a socket; behavior is controlled by:
  - `OPENCLAW_NODE_EXEC_HOST=app` (enforce)
  - `OPENCLAW_NODE_EXEC_FALLBACK=0` (disable fallback). (`src/node-host/runner.ts`)

Node host state:
- Persists `node.json` in the OpenClaw state dir with mode 0600; includes `nodeId`, token, displayName, and gateway info. (`src/node-host/config.ts`)

### Companion App Implementations (apps/*)

Shared OpenClawKit node session:
- `apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift`
  - Sends node-originated events via `node.event` with `payloadJSON`.
  - Handles `node.invoke.request` and replies via `node.invoke.result`.
  - Enforces invoke timeouts locally via an explicit "latch" so timeouts win even if UI prompts block.

iOS:
- `apps/ios/Sources/Model/NodeAppModel.swift`: implements canvas/camera/screen/location node commands and sends `voice.transcript` + `agent.request`.
- `apps/ios/Sources/Voice/TalkModeManager.swift`: uses `chat.subscribe` / `chat.unsubscribe` and `chat.send` to support Talk Mode.
- `apps/ios/Sources/Chat/IOSGatewayChatTransport.swift`: chat UI transport subscribes to chat events via `chat.subscribe`.

Android:
- `apps/android/app/src/main/java/ai/openclaw/android/gateway/GatewaySession.kt`: handles `node.invoke.request` and replies with `node.invoke.result`; also exposes `sendNodeEvent` helper for `node.event`.
- `apps/android/app/src/main/java/ai/openclaw/android/NodeRuntime.kt`: implements canvas/camera/screen/location plus `sms.send`, and emits `agent.request` for voice wake and other surfaces.

macOS:
- `apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift`: declares caps/commands and connects as role=node.
- `apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift`: implements `system.run/which/notify/execApprovals`, emits `exec.*` events, and handles permission prompts.
- Pairing UX is driven by `node.pair.requested` / `node.pair.resolved` events in `apps/macos/Sources/OpenClaw/NodePairingApprovalPrompter.swift`.
