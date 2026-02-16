# Sessions and Routing
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Sessions + Transcripts

- Session keys are string identifiers used for persistence + concurrency. Agent session keys generally look like:
  agent:<agentId>:<mainKey> or agent:<agentId>:<channel>:<kind>:<peerId>
  (see src/routing/session-key.ts and src/sessions/session-key-utils.ts)

- Store vs request keys:
  - OpenClaw persists agent-scoped keys as `agent:<agentId>:...` ("store keys") but many call sites also work with the `...` suffix ("request keys").
  - `toAgentRequestSessionKey` strips the `agent:<agentId>:` prefix when present; `toAgentStoreSessionKey` adds it back (and also normalizes `subagent:` keys under the chosen agent). (`src/routing/session-key.ts`)

- Session key construction details (`src/routing/session-key.ts`):
  - `normalizeAgentId` / `normalizeAccountId` enforce a path-safe token (`[a-z0-9_-]`, max 64, best-effort collapse invalid chars to `-`), defaulting to `main` / `default`.
  - DM scoping is controlled by `session.dmScope`:
    - `main` collapses DMs to the agent main session (`agent:<agentId>:main`).
    - `per-peer`: `agent:<agentId>:dm:<peerId>`
    - `per-channel-peer`: `agent:<agentId>:<channel>:dm:<peerId>`
    - `per-account-channel-peer`: `agent:<agentId>:<channel>:<accountId>:dm:<peerId>`
  - `session.identityLinks` can collapse DM identities across channels by mapping provider-scoped ids (e.g. `telegram:111`, `discord:222`) to a canonical peer id (the canonical key is lowercased when used in the session key).
  - Thread session suffixes are appended as `:thread:<threadId>` (when enabled by the caller) via `resolveThreadSessionKeys`.
  - `resolveThreadParentSessionKey` (`src/sessions/session-key-utils.ts`) strips the *last* `:thread:` or `:topic:` suffix to recover the parent key.

- Routing decides which agent/session receives an inbound message based on bindings (config.bindings) and message metadata (`src/routing/resolve-route.ts` + tests):
  - Bindings are filtered by `channel` and `accountId` first. Missing `match.accountId` only matches the `default` account; `match.accountId="*"` matches any account.
  - Resolution priority:
    - exact `peer` binding
    - `parentPeer` binding (thread inheritance) when peer doesn't match directly
    - guild binding (`guildId`)
    - team binding (`teamId`)
    - account-only binding (no peer/guild/team)
    - channel fallback binding (`accountId="*"`, no peer/guild/team)
    - default agent id
  - Agent ids in bindings are sanitized and, when `agents.list` is present, non-existent ids fall back to the configured default agent.

- Session send policy (allow/deny) is configurable (src/sessions/send-policy.ts).
  - `resolveSendPolicy` enforces `entry.sendPolicy` as the highest-priority override; otherwise it evaluates configured rules matching by `channel`, `chatType`, and/or `keyPrefix`.
  - Deny rules win immediately; allow rules only apply if they match at least one rule; otherwise it falls back to `session.sendPolicy.default` (default allow).

- Session entry overrides:
  - `applyModelOverrideToSessionEntry` (`src/sessions/model-overrides.ts`) sets or clears `providerOverride`/`modelOverride` and also manages `authProfileOverride` + source bookkeeping, bumping `updatedAt` when modified.
  - `applyVerboseOverride` (`src/sessions/level-overrides.ts`) manages per-session `verboseLevel` (set/clear).

### Sessions Tools (List/History/Send/Spawn)

These are OpenClaw agent tools that operate via Gateway RPC (primarily `sessions.*`, `chat.history`, `agent`, `agent.wait`, and `send`).

- `sessions_list` (`src/agents/tools/sessions-list-tool.ts`):
  - Calls `sessions.list` and optionally includes recent messages by calling `chat.history` per session.
  - Classifies session kinds (`main|group|cron|hook|node|other`) via `classifySessionKind` in `src/agents/tools/sessions-helpers.ts`.
  - Cross-agent visibility is filtered by `tools.agentToAgent` policy (`src/agents/tools/sessions-helpers.ts`).
  - When running from a sandboxed (non-subagent) session and `agents.defaults.sandbox.sessionToolsVisibility="spawned"` (default), listing is restricted to sessions with `spawnedBy=<requesterSessionKey>`.

- `sessions_history` (`src/agents/tools/sessions-history-tool.ts`):
  - Resolves session references (sessionKey vs sessionId-like inputs) via `resolveSessionReference` (`src/agents/tools/sessions-helpers.ts`), which prefers key-based resolution to avoid misclassifying custom keys as sessionIds.
  - Filters out tool messages by default (role `toolResult`), unless `includeTools=true`.
  - Enforces the same cross-agent policy gates as `sessions_list`.
  - For sandboxed (non-subagent) sessions with visibility `"spawned"`, history access is limited to sessions that appear in `sessions.list` with `spawnedBy=<requesterSessionKey>`.

- `sessions_send` (`src/agents/tools/sessions-send-tool.ts`):
  - Sends a message into another session by calling `agent` with `deliver=false`, `channel=webchat` (internal), and `lane=nested`, then optionally waits (`agent.wait`) and reads reply text from `chat.history`.
  - If `timeoutSeconds=0`, it is fire-and-forget but still kicks off an async announce flow.
  - Agent-to-agent restrictions are separate from subagent spawning: cross-agent sends require `tools.agentToAgent.enabled=true` and must pass `tools.agentToAgent.allow` patterns (same policy as list/history).
  - After the initial send/wait, `runSessionsSendA2AFlow` (`src/agents/tools/sessions-send-tool.a2a.ts`) may:
    - run a bounded ping-pong (max turns capped at 5; configured by `session.agentToAgent.maxPingPongTurns`),
    - then ask the target session to produce an "announce" reply,
    - then deliver that reply via `send` to the target channel/to resolved from the session key or via `sessions.list` lookup (`src/agents/tools/sessions-announce-target.ts`).
    - The ping-pong/announce steps use sentinel strings `"REPLY_SKIP"` and `"ANNOUNCE_SKIP"` to allow intentional silence.

- `sessions_spawn` (`src/agents/tools/sessions-spawn-tool.ts` + `src/agents/subagent-registry.ts`):
  - Spawns a background subagent run by calling `agent` with `lane=subagent` and `deliver=false`, in a new child session key `agent:<targetAgentId>:subagent:<uuid>`.
  - Forbidden when invoked from an existing subagent session key.
  - Cross-agent spawning is controlled by per-agent allowlist `agents.list[].subagents.allowAgents` (supports `"*"`; ids are normalized), not by `tools.agentToAgent.*`.
  - Subagent defaults can come from config:
    - model: `agents.defaults.subagents.model` (and per-agent overrides `agents.list[].subagents.model`), applied by attempting `sessions.patch` on the child session before starting the run (recoverable errors like "invalid model" only warn and continue).
    - thinking: `agents.defaults.subagents.thinking` (and per-agent override), validated via `normalizeThinkLevel`.
  - After spawning, the run is registered in `subagent-registry` which waits for completion (via `agent.wait`, plus an in-process lifecycle listener fallback) and triggers `runSubagentAnnounceFlow` (`src/agents/subagent-announce.ts`) to announce results back into the requester session (prefer steering/queueing when the requester is actively running).
