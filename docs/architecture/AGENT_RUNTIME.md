# Agent Runtime
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Models + Providers, Tools + Sandbox, Exec Approvals, Auto-reply Pipeline

The agent execution engine is the embedded Pi runtime (the @mariozechner/pi-* packages), wrapped by OpenClaw glue code in `src/agents/`.

Core orchestration:
- `src/agents/pi-embedded-runner/run.ts`: outer loop (lanes, auth-profile rotation, auto-compaction retry on overflow, failover signaling).
- `src/agents/pi-embedded-runner/run/attempt.ts`: single attempt setup (sandbox, skills env, bootstrap context, tool list, system prompt, transcript hygiene, hooks) + prompt execution.
- `src/agents/pi-embedded-subscribe.ts` + `src/agents/pi-embedded-subscribe.handlers.*`: converts provider stream events into partial replies, block replies, tool summaries/output, and reasoning streams, and suppresses duplicate user-facing replies after messaging-tool sends.

Session transcript hygiene + persistence guards (used to keep strict providers happy and keep session files readable):
- JSONL session file repair: `src/agents/session-file-repair.ts` drops malformed JSONL lines, writes a backup, and atomically rewrites the cleaned file (only if the first entry is a valid session header).
- Session write lock: `src/agents/session-write-lock.ts` uses a `.lock` file with `{pid, createdAt}` to avoid concurrent writers; it reclaims stale/non-alive locks and cleans up on exit/termination signals. Within a process, locks are reference-counted and normalized via `realpath` to dedupe symlinked paths.
- Transcript repair for tool calls/results: `src/agents/session-transcript-repair.ts`
  - Drops malformed tool calls missing `input`/`arguments`.
  - Ensures assistant toolCall turns are immediately followed by matching toolResult messages by moving results, dropping duplicates/orphans, and inserting synthetic error toolResults for missing ids.
- Persistence-time tool-result guard: `src/agents/session-tool-result-guard.ts` monkey-patches the Pi `SessionManager.appendMessage` so missing toolResults are synthesized before non-tool messages are persisted; integrates with plugin hook `tool_result_persist` via `src/agents/session-tool-result-guard-wrapper.ts` to allow synchronous transforms (e.g., stripping large `toolResult.details`) before writing transcripts.

Tools + sandbox:
- `src/agents/pi-tools.ts`: canonical tool list builder + layered tool policy filtering + schema normalization.
- `src/agents/sandbox/*`: sandboxed execution (Docker container + optional browser) decided by `sandbox.mode` and session key.

Tool policy and schema hygiene highlights:
- Tool allow/deny lists support tool groups (group:fs/group:runtime/etc) and `*` wildcards; deny wins.
- Provider- and model-specific tool policies can be keyed by provider id or provider/model in tools.byProvider.
- Tool schemas are normalized to avoid provider rejections (notably OpenAI top-level object requirement and Gemini keyword restrictions).

Exec approvals and allowlisting:
- Exec approvals policy file (`src/infra/exec-approvals.ts`):
  - Persistent config lives at `~/.openclaw/exec-approvals.json` with a per-install socket config `{ path, token }` (default socket path `~/.openclaw/exec-approvals.sock`). `ensureExecApprovals` creates/updates the file so both socket path and token are present.
  - Policy is resolved per agentId with optional `agents["*"]` wildcard merge and legacy `agents.default` migrated to `agents.main` (`DEFAULT_AGENT_ID`).
  - `ExecSecurity` is `deny|allowlist|full`; `ExecAsk` is `off|on-miss|always`; `askFallback` is a security mode to apply when an approval decision cannot be obtained.
  - Allowlist entries are path-based glob patterns (support `*`, `?`, and `**`); basename-only patterns are ignored and a match requires a resolved executable path (tested in `src/infra/exec-approvals.test.ts`).
  - `evaluateShellAllowlist` parses shell commands into pipeline segments and (on non-Windows) chain parts (`&&`, `||`, `;`) while respecting quotes. It rejects dangerous shell features (e.g. command substitution `$()` and backticks) and returns `analysisOk=false` when parsing fails.
  - "Safe bins" (`DEFAULT_SAFE_BINS`) can satisfy allowlist evaluation when the executable is in the safe set and the args do not appear to reference local file paths (including `--flag=path` or existing relative file names).
  - Approval gating is computed by `requiresExecApproval`: ask when `ask=always`, or when `ask=on-miss` and `security=allowlist` and analysis fails or does not satisfy allowlist.
  - Approval persistence helpers:
    - `recordAllowlistUse` updates allowlist metadata (`lastUsedAt`, `lastUsedCommand`, `lastResolvedPath`) for matched entries.
    - `addAllowlistEntry` adds an exact resolvedPath pattern (used when a user approves "allow-always" on an allowlist-gated host).
  - Socket approvals (`requestExecApprovalViaSocket`): connects to the UNIX socket path, writes newline-delimited JSON `{ type:"request", token, id, request }`, and waits (default 15s) for a `{ type:"decision", decision }` line; errors/timeouts return `null`.
- Exec approval forwarding to message channels (`src/infra/exec-approval-forwarder.ts`):
  - When enabled via `cfg.approvals.exec`, the forwarder emits "approval required" messages to either:
    - the session's last delivery target (resolved from the session store's last-route), and/or
    - explicit configured targets (`cfg.approvals.exec.targets`),
    depending on mode `session|targets|both`.
  - Pending approvals are tracked in-memory; a timer sends an "expired" message at `expiresAtMs` unless resolved earlier (tested in `src/infra/exec-approval-forwarder.test.ts`).

Heartbeats (gateway-side periodic "check-in" runs):
- Heartbeat scheduler + runner: `src/infra/heartbeat-runner.ts`
  - A heartbeat is an agent run with `{ isHeartbeat: true }` that uses `getReplyFromConfig` and routes delivery through the normal outbound channel adapters.
  - Enablement:
    - If any `agents.list[].heartbeat` entries exist, only those agents run heartbeats.
    - Otherwise, only the default agent runs heartbeats.
    - `heartbeat.every` parses duration strings with a default unit of minutes; invalid/zero disables heartbeats for that agent.
  - Quiet hours: optional `heartbeat.activeHours` (`start`, `end`, `timezone=user|local|<IANA tz>`) suppresses runs outside the configured window.
  - Backpressure: skips when the main command lane has in-flight requests (`getQueueSize(CommandLane.Main) > 0`).
  - HEARTBEAT.md optimization:
    - If `HEARTBEAT.md` exists in the agent workspace and is "effectively empty", the runner skips (to save model calls).
    - Exception: `reason="exec-event"` runs even when the file is empty, because it may need to relay pending exec completion system events.
  - Session targeting:
    - Heartbeats run in the agent's main session by default, but `heartbeat.session` can pin to a specific session key (validated to be within the agent's session scope).
    - Delivery defaults to the session's last-route target unless overridden via `heartbeat.target`/`heartbeat.to` (via `resolveHeartbeatDeliveryTarget`).
  - Visibility and "OK" acks:
    - Per-channel/per-account visibility (`showOk`, `showAlerts`, `useIndicator`) is resolved by `src/infra/heartbeat-visibility.ts`.
    - `HEARTBEAT_OK` (`HEARTBEAT_TOKEN` in `src/auto-reply/tokens.ts`) is the canonical "nothing to report" token.
    - Token stripping is implemented by `stripHeartbeatToken` (`src/auto-reply/heartbeat.ts`):
      - Strips the token only at the edges (prefix/suffix), not in the middle of a sentence.
      - Normalizes lightweight markup so `<b>HEARTBEAT_OK</b>` and `**HEARTBEAT_OK**` strip as well.
      - In `mode="heartbeat"`, a short remainder (<= `ackMaxChars`, default 300) is treated as an ack and is suppressed; longer remainders are treated as real alert content.
    - When `showOk=true`, the runner can send a bare `HEARTBEAT_OK` as an acknowledgement even when other delivery is suppressed.
  - Dedupe: suppresses identical text-only heartbeat payloads for 24h using `entry.lastHeartbeatText` + `entry.lastHeartbeatSentAt`.
  - "Do not keep the session alive":
    - When a heartbeat produces no deliverable content (or is suppressed as OK token), it restores the prior `updatedAt` on the session store entry so heartbeats do not extend session freshness.
- HEARTBEAT.md parsing helpers: `src/auto-reply/heartbeat.ts`
  - `isHeartbeatContentEffectivelyEmpty` treats a file as empty when it has only whitespace, markdown headers, and empty list bullets; a missing file returns false so the model still runs and decides what to do.
- Heartbeat wake and coalescing: `src/infra/heartbeat-wake.ts`
  - `requestHeartbeatNow` coalesces wake-ups (default 250ms), runs the configured handler once, and retries after 1s when skipped due to "requests-in-flight".
- Heartbeat events: `src/infra/heartbeat-events.ts`
  - Emits last-known heartbeat event payloads (sent/skipped/failed/ok-*) with an optional `indicatorType` used for UI status.
- System events (ephemeral prompt prefixes): `src/infra/system-events.ts`
  - Provides a session-scoped in-memory queue of human-readable "System:" lines that should be prefixed into the next prompt for that session.
  - Requires an explicit `sessionKey` (throws on empty keys) to avoid leaking across sessions.
  - Dedupes consecutive identical `text` and caps each session queue at 20 events; `drain*` clears the queue after injection.
  - Supports an optional `contextKey` which is normalized and tracked so callers can detect when the event context changed (`isSystemEventContextChanged`).

Core OpenClaw tools (via `src/agents/openclaw-tools.ts`):
- `message` (`src/agents/tools/message-tool.ts`):
  - Schema is action-discriminated and dynamically built from config:
    - Actions come from `listChannelMessageActions(cfg)`; if none, tool falls back to `["send"]`.
    - The schema only includes Telegram `buttons` when `supportsChannelMessageButtons(cfg)` is true, and only includes Adaptive Card `card` when `supportsChannelMessageCards(cfg)` is true.
  - Tool description is also context-aware:
    - If `currentChannelProvider` is set, it lists only that channel's supported actions.
    - BlueBubbles special-case: when current target is a DM (not group), group-only actions are hidden from the description (`BLUEBUBBLES_GROUP_ACTIONS`), based on `currentChannelId` normalization.
  - When `requireExplicitTarget` is true, explicit routing is enforced for send-like actions (must provide `target`/`to`/`channelId`/`targets`).
  - When `sandboxRoot` is set, `path` and `filePath` are validated with `assertSandboxPath` to prevent escaping the sandbox root.
  - Uses `runMessageAction` (`src/infra/outbound/message-action-runner.ts`) and passes a toolContext that sets `skipCrossContextDecoration: true` (direct tool usage should not add cross-context decoration).
  - Derives `agentId` from `agentSessionKey` via `resolveSessionAgentId` and passes it through for auditing/metrics.
- `gateway` (`src/agents/tools/gateway-tool.ts` + helper `src/agents/tools/gateway.ts`):
  - Schema is intentionally flattened (no top-level anyOf/oneOf/allOf) for provider compatibility; runtime enforces conditional requirements.
  - `restart` requires `config.commands.restart=true`. It writes a best-effort restart sentinel (`restart-sentinel.json`) and schedules a SIGUSR1 restart, attempting to capture delivery context from the session store (including `:thread:` markers in session keys).
  - `config.apply` / `config.patch` default `baseHash` by calling `config.get` when not provided, and default `sessionKey` from the invoking agent session.
  - `update.run` defaults to a 20 minute timeout unless overridden.
  - `callGatewayTool` leaves `gatewayUrl` undefined by default so the gateway client can fall back to config; timeout defaults to 30s.
- `cron` (`src/agents/tools/cron-tool.ts`):
  - Uses provider-friendly schemas for `job`/`patch` (`Type.Object({}, { additionalProperties: true })`) and relies on runtime normalization/validation.
  - Normalizes `cron.add` jobs via `normalizeCronJobCreate` and `cron.update` patches via `normalizeCronJobPatch`.
  - If `job.agentId` is missing (but not null), it defaults `agentId` from the invoking `agentSessionKey`.
  - For `payload.kind="systemEvent"`, supports optional `contextMessages` (0-10) which fetches recent messages via `chat.history` and appends a compact "Recent context:" block to the reminder text (bounded per-message and total length, UTF-16 safe).
  - `wake` uses `callGatewayTool("wake", ..., { expectFinal: false })` with mode `now` or `next-heartbeat` (default).
- `tts` (`src/agents/tools/tts-tool.ts`):
  - Wraps `textToSpeech` (`src/tts/tts.ts`) and returns `MEDIA:<path>` on success.
  - If the output is voice-compatible, it prepends `[[audio_as_voice]]` so Telegram renders a voice bubble instead of a generic file.

Auth profiles and provider auth (agent-side):
- Store format and location:
  - Auth profile store file is `auth-profiles.json` in the agentDir (`src/agents/auth-profiles/paths.ts` + `src/agents/auth-profiles/constants.ts`).
  - Legacy store `auth.json` is migrated to `auth-profiles.json` and deleted after a successful write (PR #368 behavior in `src/agents/auth-profiles/store.ts`).
  - Store schema (`src/agents/auth-profiles/types.ts`):
    - `profiles[profileId]` entries can be `api_key`, `token` (non-refreshable), or `oauth` (refreshable).
    - Optional `order` (per-agent overrides), `lastGood` (per-provider), and per-profile `usageStats` (lastUsed, cooldownUntil, disabledUntil, counters).
- Store loading and merging:
  - `ensureAuthProfileStore(agentDir)` loads the agent store and merges in main-agent auth profiles (main first, then agent overrides). (`src/agents/auth-profiles/store.ts`)
  - If an agent has no auth store yet, it can inherit the main store by cloning `auth-profiles.json` into the agent dir (so secondary agents have a baseline).
  - On every store load, OpenClaw may sync credentials from external CLIs (Qwen CLI, MiniMax CLI) into well-known profile ids, with TTL and near-expiry guards. (`src/agents/auth-profiles/external-cli-sync.ts`)
- Profile ordering and selection:
  - `resolveAuthProfileOrder` (`src/agents/auth-profiles/order.ts`) precedence:
    - store order override (`store.order`) wins over config `auth.order`
    - otherwise, config `auth.profiles` entries for the provider are used if present
    - otherwise, all stored profiles for the provider are considered
  - Filtering drops invalid/mismatched entries:
    - wrong provider, missing keys/tokens, expired token creds, and config mode/provider mismatches.
    - Compatibility: config mode `oauth` accepts stored `token` credentials (issue #559); config mode `token` rejects stored `oauth`.
  - Ordering rules:
    - With an explicit order, the explicit sequence is preserved, but profiles currently in cooldown/disabled are pushed later (soonest expiring first).
    - Without an explicit order, OpenClaw uses round-robin: prefer type `oauth` > `token` > `api_key`, and within a type sort by `lastUsed` oldest-first; cooldown/disabled profiles are appended.
    - `lastGood` is not used for prioritization (it would defeat round-robin).
- Cooldowns and backoff:
  - `markAuthProfileFailure` / `markAuthProfileUsed` (`src/agents/auth-profiles/usage.ts`) update `usageStats` with a file lock (`proper-lockfile`) to avoid concurrent writers.
  - Non-billing failures apply exponential cooldown (1m, 5m, 25m, then capped at 1h).
  - Billing failures set `disabledUntil` with a longer backoff (defaults ~5h) and supports per-provider overrides and a failure window reset (`cfg.auth.cooldowns.*`).
- OAuth resolution and refresh:
  - `resolveApiKeyForProfile` (`src/agents/auth-profiles/oauth.ts`) returns a usable apiKey for `api_key` / `token` / `oauth` profiles.
  - OAuth refresh is lock-protected per agent store file; providers can have custom refresh flows (notably `chutes` and `qwen-portal`).
  - If refresh fails, it can:
    - attempt a fallback profile id when legacy `:default` OAuth config points at an email-scoped profile id (`suggestOAuthProfileIdForLegacyDefault` / `repairOAuthProfileIdMismatch`),
    - and, for secondary agents, fall back to main-agent OAuth creds when the main agent has a fresh token (copies it into the secondary agent store).
- Session-level auth profile overrides:
  - Sessions can persist `authProfileOverride` metadata in the session store (`src/agents/auth-profiles/session-override.ts`).
  - Auto overrides rotate on new session creation and on compaction boundaries, and will clear themselves if they become invalid (missing, wrong provider, not in resolved order).

Models: catalog, selection, allowlists, and fallback:
- Curated catalog (for UI + allowlist validation):
  - `loadModelCatalog` (`src/agents/model-catalog.ts`) reads models from pi-coding-agent's `ModelRegistry` (via `src/agents/pi-model-discovery.ts`) and returns a sorted list `{ provider, id, name, contextWindow?, reasoning?, input? }`.
  - It uses a dynamic import of the pi SDK and intentionally does not poison the cache on transient failures (e.g., node_modules churn during installs). It warns only once and retries on the next call.
  - `modelSupportsVision` checks `entry.input` for `"image"`.
- Model refs and aliases:
  - Model keys are `provider/model` (`modelKey` in `src/agents/model-selection.ts`).
  - Provider normalization (`normalizeProviderId`) includes:
    - `z.ai` and `z-ai` -> `zai`
    - `opencode-zen` -> `opencode`
    - `qwen` -> `qwen-portal`
    - `kimi-code` -> `kimi-coding`
  - Some model ids are provider-normalized:
    - Anthropic aliases: `opus-4.5` -> `claude-opus-4-5`, `sonnet-4.5` -> `claude-sonnet-4-5`
    - Google Gemini 3 ids are normalized to preview ids (`src/agents/models-config.providers.ts`).
  - Aliases are configured under `agents.defaults.models` mapping `provider/model` -> `{ alias }` and resolved by `buildModelAliasIndex` + `resolveModelRefFromString`.
  - Configured `agents.defaults.model` may be a string or object. If a non-alias string lacks a provider, OpenClaw warns and falls back to `anthropic/<model>` (deprecated behavior in `resolveConfiguredModelRef`).
- Allowlisting:
  - If `agents.defaults.models` is empty, allowlist is effectively "allow any" (plus the default model key is always included).
  - If a model ref is not in the catalog but its provider is explicitly configured in `models.providers`, it is still allowlist-able (so custom proxies do not need to be in the curated catalog).
  - `resolveAllowedModelRef` returns a `model not allowed: provider/model` error when allowlisting is active and the ref is not permitted.
- models.json generation and implicit providers:
  - `ensureOpenClawModelsJson` (`src/agents/models-config.ts`) writes `models.json` under the agentDir, by merging:
    - explicit `cfg.models.providers`, and
    - implicit providers discovered from env/auth (`src/agents/models-config.providers.ts`)
  - Default mode is `merge`:
    - it merges new providers into an existing `models.json` (existing entries are preserved unless overwritten by newly discovered/explicit providers).
  - Provider normalization (`normalizeProviders`) fixes common config mistakes and keeps pi-coding-agent happy:
    - If `apiKey` is set as `"${ENV_VAR}"`, it is normalized to `"ENV_VAR"`.
    - If a provider defines `models` but lacks `apiKey`, it attempts to fill it from env vars or auth profiles (for aws-sdk providers it writes the relevant AWS env var name).
    - Google provider models have gemini-3 ids normalized to preview ids.
  - Implicit providers include (when matching env tokens or profiles exist): minimax, minimax-portal (OAuth placeholder), moonshot, qwen-portal (OAuth placeholder), synthetic, venice, xiaomi, cloudflare-ai-gateway, and github-copilot (baseUrl discovered via token exchange). Ollama is intentionally excluded unless explicitly configured.
  - Optional Bedrock provider can be discovered when AWS credentials exist (or when forced on via config), via `discoverBedrockModels`.
- Fallback and failover:
  - `runWithModelFallback` (`src/agents/model-fallback.ts`) retries across a candidate list:
    - primary candidate is the requested provider/model (with defaults applied when missing),
    - then `agents.defaults.model.fallbacks` (or an explicit `fallbacksOverride` list),
    - and (only when `fallbacksOverride` is not provided) it appends the configured primary as a last candidate.
  - Fallback candidates are allowlist-enforced (fallback list entries are skipped when not in `agents.defaults.models`, but the initial requested model is always attempted).
  - Provider-wide cooldown gating: when an auth store is available, OpenClaw can skip attempting a provider if all profiles for that provider are in cooldown, recording a `rate_limit` attempt without making a request.
  - Only "failover-classified" errors trigger fallback: errors are coerced into `FailoverError` (`src/agents/failover-error.ts`) based on status/code/message.
    - User aborts (`AbortError` without timeout hints) are rethrown and do not fall back.
    - Timeouts are treated as failover-worthy even when they are wrapped as aborts.
  - `runWithImageModelFallback` uses `agents.defaults.imageModel.primary` (or `modelOverride`) plus `agents.defaults.imageModel.fallbacks`, and errors when no image model is configured.
- Provider compat patches:
  - `normalizeModelCompat` (`src/agents/model-compat.ts`) disables developer-role support for `zai` OpenAI-completions models (provider quirk workaround).

Skills (SKILL.md skill packs used to build prompt context + slash commands):
- Loader + prompt builder: `src/agents/skills/workspace.ts` (re-exported via `src/agents/skills.ts`).
  - Skill sources:
    - workspace skills: `<workspaceDir>/skills`
    - managed skills: `~/.openclaw/skills` (`CONFIG_DIR/skills`)
    - bundled skills: resolved by `resolveBundledSkillsDir` (`src/agents/skills/bundled-dir.ts`) or overridden by `OPENCLAW_BUNDLED_SKILLS_DIR`
    - extra dirs: `skills.load.extraDirs`
    - plugin-shipped skills: declared in `openclaw.plugin.json` `skills` and discovered via `src/agents/skills/plugin-skills.ts` (only from enabled plugins; memory-slot rules apply)
  - Source precedence for duplicate skill names: `extra < bundled < managed < workspace`.
  - Eligibility gating: `src/agents/skills/config.ts` checks metadata `requires` (bins/anyBins/env/config) and `os`, with `always=true` bypassing missing requirements.
    - Config gates use `isConfigPathTruthy`, with defaults for some paths like `browser.enabled` and `browser.evaluateEnabled`.
    - Bundled skills can be allowlisted via `skills.allowBundled`; non-bundled skills are unaffected (`isBundledSkillAllowed`).
    - `metadata.skillKey` (if present) is used as the config key for enable/disable and API key injection.
  - Prompt shaping:
    - `disable-model-invocation: true` skills are excluded from the prompt but still appear in snapshots/status lists.
    - A `skillFilter` allowlist can be applied; an empty list intentionally yields no skills.
  - Command surface:
    - `buildWorkspaceSkillCommandSpecs` generates user-invocable `/commands`, sanitizes and de-duplicates names, and truncates descriptions to 100 chars for Discord compatibility.
    - Optional deterministic dispatch: frontmatter `command-dispatch: tool` + `command-tool: <toolName>` + `command-arg-mode: raw`.
  - Env injection:
    - `applySkillEnvOverrides` / `applySkillEnvOverridesFromSnapshot` set env vars from `skills.entries.<skillKey>.env` and inject `apiKey` into the skill's `primaryEnv` when needed, restoring env on cleanup.

Skills refresh + sandbox mirroring:
- Watcher + snapshot versioning: `src/agents/skills/refresh.ts` watches skills directories (workspace/managed/extra/plugin) and bumps a per-workspace/global snapshot version so running sessions can refresh prompt context.
- When sandboxing with limited workspace access, OpenClaw may copy skills into the sandbox workspace via `syncSkillsToWorkspace` (used by `src/agents/sandbox/workspace.ts`).

Session-scoped prompt updates (system events + skill snapshots):
- `prependSystemEvents` (`src/auto-reply/reply/session-updates.ts`) drains the ephemeral per-session system event queue (`src/infra/system-events.ts`), compacts noisy lines (notably heartbeat scheduling chatter), timestamps events using `agents.defaults.envelopeTimezone`, and prefixes them as `System: [<ts>] ...` before the user prompt.
  - On the first turn of a brand-new main session, it also prepends a channel summary (`buildChannelSummary`) so the agent sees current connectivity/status context.
- `ensureSkillSnapshot` (`src/auto-reply/reply/session-updates.ts`) ensures a `skillsSnapshot` is computed and recorded into the session store when `isFirstTurnInSession` is true, and refreshes it when the skills watcher snapshot version increases.
  - It also flips `systemSent=true` when it writes the first-turn session entry (used to avoid repeating system preamble work across turns).
- `incrementCompactionCount` (`src/auto-reply/reply/session-updates.ts`) updates session-store metadata after compaction (`compactionCount`, `updatedAt`, and optionally `totalTokens`).

Inbound envelope formatting and dispatch:
- Envelope formatting (`src/auto-reply/envelope.ts`):
  - Produces compact agent-visible headers like `[Channel From Host IP <timestamp>] body`.
  - Timestamp formatting is controlled by `agents.defaults.envelopeTimezone` and flags `agents.defaults.envelopeTimestamp` / `agents.defaults.envelopeElapsed`:
    - timezone supports `local` (default), `utc`, `user` (uses `agents.defaults.userTimezone`), or an explicit IANA timezone.
    - when `previousTimestamp` is provided, it can append an elapsed suffix to the `from` field (e.g. `Alice +2m`).
  - Inbound formatting (`formatInboundEnvelope`) prefixes sender labels for non-direct chats (`Sender: body`) but keeps direct messages unprefixed; sender labels can be supplied explicitly or derived from sender identity fields (`resolveSenderLabel`).
- Inbound dispatch (`src/auto-reply/dispatch.ts`):
  - Normalizes an inbound `MsgContext` to a finalized form (`finalizeInboundContext`) and dispatches through `dispatchReplyFromConfig` (which owns the reply pipeline).
  - Provides helpers to create and own a `ReplyDispatcher`, including a buffered typing-capable dispatcher (`createReplyDispatcherWithTyping`) that returns `markDispatchIdle()` for post-dispatch cleanup.
 - Context + templating primitives:
   - `MsgContext` and `FinalizedMsgContext` (`src/auto-reply/templating.ts`) define the cross-channel inbound context object used throughout auto-reply (envelopes, routing, directives, and template rendering).
   - `GetReplyOptions` and `ReplyPayload` (`src/auto-reply/types.ts`) define the reply callbacks (partial/block/tool/reasoning) and payload shape used across inbound surfaces and outbound adapters.
   - `applyTemplate` (`src/auto-reply/templating.ts`) is simple `{{Key}}` interpolation against the message context; non-string values are formatted conservatively (arrays become comma-joined primitives, objects become empty strings).

Auto-reply control commands (slash commands):
- Canonical command list and command metadata: `src/auto-reply/commands-registry.data.ts` + `src/auto-reply/commands-registry.types.ts`
  - Commands have a `scope` (`text`, `native`, `both`) plus an optional category used for `/commands` formatting (`session`, `options`, `status`, `management`, `media`, `tools`, `docks`).
  - Dock commands are generated automatically for channel docks that advertise `capabilities.nativeCommands` (from `listChannelDocks()`).
  - The registry is validated at startup (`assertCommandRegistry`) to prevent duplicate keys, duplicate native names, and duplicate text aliases, and to enforce basic invariants (e.g. text-only commands must have at least one `/alias`).
- Command normalization and argument utilities: `src/auto-reply/commands-registry.ts`
  - `normalizeCommandBody` canonicalizes text command bodies:
    - Converts `/cmd: args` into `/cmd args`.
    - Supports Telegram-style `/cmd@bot` mentions and strips the `@bot` suffix only when it matches `botUsername`.
    - Canonicalizes known aliases to the *primary* alias for the command (important for keys like `dock:<id>` where the public alias is `/dock-<id>`).
    - Drops multi-line tails by considering only the first line for detection/normalization.
  - `parseCommandArgs` implements positional parsing with `captureRemaining` support. `serializeCommandArgs` prefers `args.raw` when present; otherwise it renders from `args.values` using either `formatArgs` or positional formatting.
  - `resolveCommandArgMenu` supports `argsMenu: "auto"` for "pick the first arg with choices" menus. It intentionally does not show menus when args are provided as raw text only (no parsed values).
  - `shouldHandleTextCommands` implements the global text-command gate:
    - Native command invocations (`CommandSource === "native"`) always allow command handling.
    - If `cfg.commands.text !== false`, text commands are enabled everywhere.
    - If `cfg.commands.text === false`, text commands are only enabled on surfaces that do *not* support native commands (so channels without native commands are not locked out).
  - Config gates:
    - `/config` and `/debug` are only enabled when `commands.config=true` / `commands.debug=true` (registry filtering is implemented by `isCommandEnabled` and enforced again by handlers).
    - `/bash` is only enabled when `commands.bash=true`.
  - Provider-specific native name overrides exist (currently `discord: tts -> voice`).
- Coarse detection used by channel monitors: `src/auto-reply/command-detection.ts`
  - `hasControlCommand` checks whether the *entire* message is a control command (with optional args), after normalization.
  - `hasInlineCommandTokens` is a low-cost "maybe command-ish" detector (e.g. `hey /status`) used to decide whether to compute `CommandAuthorized` upstream.
- Command authorization helpers: `src/auto-reply/command-auth.ts`
  - `resolveCommandAuthorization` resolves a provider id from the message context and derives an `ownerList` from the dock-configured `allowFrom` list.
  - Sender matching is dock-aware:
    - `formatAllowFrom` is applied to normalize ids.
    - WhatsApp prefers `SenderE164` over `SenderId` when building candidates so `+<e164>` allowlists work even when a message supplies an LID-style sender id.
  - Some docks can require owner matching for commands (`dock.commands.enforceOwnerForCommands`); otherwise "authorized sender" is the conjunction of `ctx.CommandAuthorized` and owner checks.
- Skill commands (slash command surface for SKILL.md packs): `src/auto-reply/skill-commands.ts`
  - Skill commands are generated from workspaces via `buildWorkspaceSkillCommandSpecs`.
  - Reserved names are derived from built-in chat commands and their aliases so skills cannot shadow core commands.
  - `resolveSkillCommandInvocation` supports both direct `/skill_name ...` and `/skill <skill_name> ...` forms.
- Built-in command handlers (executed before running the agent): `src/auto-reply/reply/commands-core.ts` and `src/auto-reply/reply/commands-*.ts`
  - Plugin commands are checked first (`src/auto-reply/reply/commands-plugin.ts`) and bypass the LLM agent when matched.
  - `/new` and `/reset` are ignored for unauthorized senders; for authorized senders they trigger an internal hook (`type=command`, action `new|reset`) and can immediately emit hook messages via `routeReply`.
  - Command handling uses `allowTextCommands` (from `shouldHandleTextCommands`) to disable text command processing on native-command surfaces when configured.
  - If no handler matches, the pipeline checks send-policy (`src/sessions/send-policy.ts`) and may stop further processing when sending is denied.
- Operator-facing help and command list formatting: `src/auto-reply/status.ts`
  - `buildHelpMessage` emits a compact help text and conditionally includes `/config` and `/debug` based on config flags.
  - `/commands` output is category-grouped and includes plugin commands (from `listPluginCommands`).
  - Telegram can use pagination (`buildCommandsMessagePaginated`) and `commands-info.ts` builds an inline keyboard with `callback_data` that optionally includes `:<agentId>`.

Skills status + install helpers (used by gateway RPC `skills.status` / `skills.install`):
- `src/agents/skills-status.ts` builds a status report (eligibility, missing requirements, and preferred install options).
- `src/agents/skills-install.ts` executes install specs from skill metadata (`brew`/`node`/`go`/`uv`/`download`); download installs use SSRF-guarded fetch and optionally extract `zip`/`tar.*` archives.

Web tools (lightweight web access):
- `web_fetch`: `src/agents/tools/web-fetch.ts`
  - Uses SSRF-guarded fetch with DNS pinning: `src/infra/net/fetch-guard.ts` + `src/infra/net/ssrf.ts`.
  - Extracts HTML via Readability (`src/agents/tools/web-fetch-utils.ts`), optionally falls back to Firecrawl when configured, and wraps returned text as untrusted external content (`src/security/external-content.ts`).
  - Leaves `url` and `finalUrl` raw for tool chaining; clamps `maxChars` after wrapping so results always fit the budget.
- `web_search`: `src/agents/tools/web-search.ts`
  - Brave Search (titles/snippets wrapped; URLs left raw) or Perplexity Sonar via Perplexity direct/OpenRouter (content wrapped; citations left raw).

Node and canvas tools (paired companion devices):
- `nodes`: `src/agents/tools/nodes-tool.ts`
  - High-level wrapper over `node.list`, `node.pair.*`, and `node.invoke` for `system.notify`, `camera.*`, `screen.record`, `location.get`, and `system.run`.
  - Media capture writes temp files and returns `MEDIA:<path>` (images) or `FILE:<path>` (videos).
- `canvas`: `src/agents/tools/canvas-tool.ts`
  - Wraps `canvas.*` node commands and supports `snapshot` (returns an image) and A2UI push/reset.
  - Default node selection is implemented in `src/agents/tools/nodes-utils.ts`.

Memory tools (optional semantic recall over local markdown):
- `memory_search` and `memory_get`: `src/agents/tools/memory-tool.ts`
  - Exposed only when memory search is enabled for the agent (`src/agents/memory-search.ts`).
  - Uses a manager selected by `src/memory/search-manager.ts` (builtin index by default; optional `qmd` backend with fallback to builtin).
  - Supports citations decoration controlled by `memory.citations` (`auto` hides citations for group/channel session keys).

Channel action tools (per-channel message operations):
- Example (Telegram): `src/agents/tools/telegram-actions.ts`
  - Extra actions beyond sendText: reactions, edits/deletes, stickers, inline buttons.
  - Controlled by `channels.telegram.actions` plus `channels.telegram.reactionLevel` and `channels.telegram.capabilities.inlineButtons` scope.
  - Token resolution: `src/telegram/token.ts`. Actual sends: `src/telegram/send.ts`.
- Example (Slack): `src/agents/tools/slack-actions.ts`
  - Covers message CRUD, reactions, pins, emoji list, member info, and reading threads.
  - Auto-threading can be driven by the outbound tool context (`currentThreadTs` + replyToMode).
  - Implements operations via `src/slack/actions.ts` and sends via `src/slack/send.ts`.
- Example (Discord): `src/agents/tools/discord-actions.ts`
  - Covers message CRUD, reactions, threads, pins, polls, search, permissions, and guild/admin actions (channels/categories/events/roles/moderation) gated via `channels.discord.actions`.
  - Presence changes are implemented via the in-process Discord gateway registry (requires the bot gateway to be connected).
  - Moderation, role changes, and presence updates are default-off unless explicitly enabled in `channels.discord.actions` (the action gate uses `defaultValue=false` for these keys).
  - Discord outbound sends:
    - chunk to 2000 chars with soft line limits and fence balancing (src/discord/chunk.ts)
    - reject bare numeric recipients as ambiguous (user vs channel) unless the caller provides a default kind (src/discord/targets.ts)
    - on missing permissions, attempts to compute which Discord permissions are missing and includes them in the error hint (src/discord/send.permissions.ts)
  - Discord channel plugin (extensions + provider monitor):
    - Extension entrypoint: `extensions/discord/index.ts` registers `discordPlugin` and injects `api.runtime` into `extensions/discord/src/runtime.ts`.
    - Plugin adapter: `extensions/discord/src/channel.ts` defines the `ChannelPlugin` surface:
      - Account config is resolved via `src/discord/accounts.ts` (default account id + token from env/config).
      - DM policy is enforced via the shared channel security adapter (pairing/open/disabled), with per-account allowFrom path differences (top-level vs accounts.<id>).
      - Group policies + tool policies are resolved through shared helpers (`resolveDiscordGroupRequireMention` / `resolveDiscordGroupToolPolicy`).
      - Directory live queries delegate into `src/discord/directory-live.ts` (guild + channel list, member search).
      - Status/probe/audit delegate into `src/discord/probe.ts` and `src/discord/audit.ts`.
    - Provider monitor: `monitorDiscordProvider` (`src/discord/monitor/provider.ts`) runs the Carbon gateway client, deploys native commands, and attaches listeners:
      - Pre-resolves configured guild/channel allowlists and user allowlists to ids via Discord APIs (`src/discord/resolve-channels.ts`, `src/discord/resolve-users.ts`) and merges resolved ids back into the effective config.
      - Supports native slash commands and optional per-skill commands; truncates to Discord's max command count (100) by dropping per-skill commands if needed.
      - Uses a HELLO timeout watchdog to detect zombie gateway connections and force reconnect.
      - Optional exec approvals integration (`src/discord/monitor/exec-approvals.ts`) listens to gateway events `exec.approval.*` and DMs approvers with allow/deny buttons.
    - Inbound message flow:
      - `createDiscordMessageHandler` (`src/discord/monitor/message-handler.ts`) debounces short text bursts from the same author/channel (when no attachments and not a control command) and then runs preflight + processing.
      - `preflightDiscordMessage` (`src/discord/monitor/message-handler.preflight.ts`) enforces DM pairing/open rules, group allowlist rules, mention gating (with bypass for authorized control commands), and PluralKit identity mapping.
      - `processDiscordMessage` (`src/discord/monitor/message-handler.process.ts`) builds a finalized inbound context:
        - Channel topics are placed into `UntrustedContext` (never `GroupSystemPrompt`) to avoid prompt injection.
        - Optional auto-threading can create a Discord thread and re-key session context to the created thread (disables message reply references when replying into a new thread).
        - Optional ack reactions are applied and can be removed after reply.
        - Reply delivery chunks text (2000 chars) and converts markdown tables before sending (`src/discord/monitor/reply-delivery.ts`).
- Example (WhatsApp Web): `src/agents/tools/whatsapp-actions.ts`
  - Supports reactions only and calls the web outbound adapter `sendReactionWhatsApp` (`src/web/outbound.ts`).
  - Polls are sent via the core `poll` action in `src/infra/outbound/message-action-runner.ts` and the WhatsApp channel plugin outbound adapter (`extensions/whatsapp/src/channel.ts` -> `sendPollWhatsApp` in `src/web/outbound.ts`).
  - Requires an active linked WhatsApp Web session: sends are routed through an in-process active listener registered by `monitorWebChannel` (`src/web/auto-reply/monitor.ts`, `src/web/active-listener.ts`).
  - WhatsApp channel plugin (extensions + web provider monitor):
    - Extension entrypoint: `extensions/whatsapp/index.ts` registers the plugin and injects `api.runtime` into `extensions/whatsapp/src/runtime.ts`.
    - Plugin adapter: `extensions/whatsapp/src/channel.ts` defines the `ChannelPlugin` surface:
      - Account resolution + authDir selection is in `src/web/accounts.ts` (including legacy default authDir fallback in `resolveWhatsAppAuthDir`).
      - DM policy and allowlists come from `channels.whatsapp.dmPolicy` + `channels.whatsapp.allowFrom` (and per-account overrides via `channels.whatsapp.accounts.<id>`).
      - Group mention and tool policy resolution uses shared helpers (`resolveWhatsAppGroupRequireMention` / `resolveWhatsAppGroupToolPolicy`).
      - QR linking is exposed as both:
        - Agent tool `whatsapp_login` (`src/channels/plugins/agent-tools/whatsapp-login.ts`), which uses a provider-friendly action enum schema (Type.Unsafe) and delegates into `src/web/login-qr.ts`.
        - Gateway RPC `web.login.start` / `web.login.wait` (`src/gateway/server-methods/web.ts`), which finds the active provider by scanning channel plugins for those gateway methods.
      - Plugin `actions.listActions` may include `poll`, but WhatsApp-specific `actions.handleAction` only handles `react`; the `poll` send path is handled by the core message-action runner.
    - Web provider runtime:
      - `monitorWebChannel` (`src/web/auto-reply/monitor.ts`) runs `monitorWebInbox` (`src/web/inbound/monitor.ts`) and registers the per-account active listener (`src/web/active-listener.ts`) used by outbound sends.
      - Inbound access control is enforced in `src/web/inbound/access-control.ts`:
        - DMs: `pairing` (default), `allowlist`, `open`, `disabled` (pairing replies create pairing requests in the pairing store).
        - Groups: `open` / `allowlist` / `disabled` (with mention gating handled separately).
      - Behavioral highlights verified by `src/web/*.test.ts` and `src/web/auto-reply*.test.ts`:
        - Early DM filtering: messages from unauthorized senders (not in `channels.whatsapp.allowFrom`) are blocked before processing; blocked senders do not get read receipts, and (when in `pairing`) receive pairing instructions (this is explicitly tested as a guard against Baileys "Bad MAC" churn).
        - Same-phone/self-chat: self-messages are allowed even with restrictive allowlists; read receipts are suppressed in self-chat mode and when `sendReadReceipts=false`; outbound DMs (`fromMe=true`) do not trigger pairing replies.
        - Auto-reply delivery: WhatsApp does not use partial replies (the resolver is invoked without an `onPartialReply` callback), and tool summaries are skipped; final replies may be prefixed by `messages.responsePrefix` when configured.
        - Reply delivery implementation: `deliverWebReply` (`src/web/auto-reply/deliver-reply.ts`) chunks converted markdown (including table conversion), retries transient send failures, sends media with per-kind fields (image/audio/video/document), and falls back to a text-only warning when the first media send fails.
        - Prefix sources are distinct: `messages.responsePrefix` is not implicitly derived from agent identity; separately, inbound context labeling can use the bound agent's `identity.name` as the message prefix in the resolver input.
        - Session last-route bookkeeping is updated for WhatsApp conversations (e.g., `lastChannel`, `lastTo`, and `lastAccountId` when present) so later outbound sends can default to the most recent peer.
        - Heartbeat: `runWebHeartbeatOnce` (`src/web/auto-reply/heartbeat-runner.ts`) resolves recipients via `src/channels/plugins/whatsapp-heartbeat.ts`, runs a heartbeat prompt through the normal reply resolver, strips/suppresses the heartbeat token, and intentionally restores the session store `updatedAt` when skipping (so heartbeats do not keep sessions alive for idle-expiry purposes).
        - Crypto error recovery: `monitorWebChannel` registers an unhandled-rejection hook that detects likely WhatsApp/Baileys crypto errors (e.g., "Bad MAC") and forces a reconnect by signaling a socket close.
      - Group mention gating + activation:
        - Mention detection: `src/web/auto-reply/mentions.ts` (explicit mentioned JIDs first; regex/digit fallback only when safe).
        - Group gating: `src/web/auto-reply/monitor/group-gating.ts` stores unmentioned group messages as pending history and only triggers on mention/activation, with an owner+control-command bypass.
      - Reconnect behavior:
        - Backoff policy is in `src/web/reconnect.ts`.
        - The monitor includes a watchdog to force reconnect when no messages arrive for an extended interval (`src/web/auto-reply/monitor.ts`).
