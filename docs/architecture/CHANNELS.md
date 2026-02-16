# Channels (Registry and Types)
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Channels + Delivery (+ provider/extension playbooks)

Core channel plumbing lives in `src/channels/*` and exists to keep shared logic lightweight (avoid importing heavy provider implementations in hot paths).

- Channel docking and metadata: `src/channels/registry.ts`
  - `CHAT_CHANNEL_ORDER` defines the default selection order for core channels (Telegram, WhatsApp, Discord, Google Chat, Slack, Signal, iMessage).
  - `normalizeChatChannelId` normalizes built-in ids and aliases (e.g. `imsg` -> `imessage`, `gchat` / `google-chat` -> `googlechat`) and returns null for unknown ids.
  - `normalizeAnyChannelId` resolves ids/aliases for *registered channel plugins* by scanning the active plugin registry. This intentionally avoids importing channel plugins directly; the plugin registry must already be initialized.
  - Formatting helpers (`formatChannelPrimerLine`, `formatChannelSelectionLine`) are used by onboarding/selection UIs to show each channel blurb plus docs pointers.

- Chat type normalization: `src/channels/chat-type.ts`
  - `normalizeChatType` maps `"dm"` to `"direct"` and returns undefined for unknown/empty values (used by policy matching such as session send-policy).

- Shared config matching helpers: `src/channels/channel-config.ts`
  - `resolveChannelEntryMatchWithFallback` supports a common "direct -> parent -> wildcard" precedence for per-channel/per-group config blocks, optionally normalizing keys (e.g. slug matching).
  - Matched config can carry `matchKey` and `matchSource` metadata (`direct|parent|wildcard`) via `applyChannelMatchMeta` to improve debug/status output.
  - `resolveNestedAllowlistDecision` encodes nested allowlist semantics used in multiple channel layers: if the outer allowlist is configured and doesn't match, deny; if it matches and the inner allowlist is configured, require an inner match.

- Allowlist utilities: `src/channels/allowlists/resolve-utils.ts`
  - `mergeAllowlist` merges allowlist additions case-insensitively while preserving the first-seen canonical string.
  - `summarizeMapping` logs compact "resolved/unresolved" summaries with bounded samples for operator-facing diagnostics.

- Channel plugin contract: `src/channels/plugins/types.plugin.ts` + `src/channels/plugins/types.*.ts`
  - A channel plugin is the unit of integration for a messaging surface. The `ChannelPlugin` surface is intentionally split into adapters so shared code can call into:
    - config/account resolution and enable/disable (`ChannelConfigAdapter`)
    - security and DM policy gating (`ChannelSecurityAdapter`, pairing helpers, elevated fallbacks)
    - outbound delivery (direct vs gateway vs hybrid) and chunking/media/polls (`ChannelOutboundAdapter`)
    - status/probe/audit and account snapshots (`ChannelStatusAdapter`)
    - optional gateway lifecycle (`ChannelGatewayAdapter`), onboarding/setup, directory lookup, resolvers, per-channel agent tools, and message actions
  - Capabilities (`ChannelCapabilities`) advertise what the channel supports (chat types, polls, reactions, media, threads, native commands, block-streaming).

- Channel plugin registry and catalogs:
  - `src/channels/plugins/index.ts` is the runtime-facing channel registry wrapper over the active plugin registry. It is explicitly "heavy" (channel plugins may import monitors/login flows), so shared code should prefer `src/channels/dock.ts` and only call `getChannelPlugin()` at execution boundaries.
  - `listChannelPlugins()` sorts plugins by channel meta order (falling back to built-in channel ordering) and dedupes by id.
  - `loadChannelPlugin()` (`src/channels/plugins/load.ts`) caches lookups per active plugin registry instance.
  - `listChannelPluginCatalogEntries()` (`src/channels/plugins/catalog.ts`) builds an installable catalog of channel plugins from plugin discovery plus optional external catalog JSON files (paths can be provided or read from env); it preserves origin precedence (config/workspace/global/bundled) and returns entries with install hints (`npmSpec`, optional `localPath`, default choice).

- Channel plugin config schema and config mutation helpers:
  - `buildChannelConfigSchema` (`src/channels/plugins/config-schema.ts`) converts a Zod schema to JSON Schema (draft-07) for use in UI/config surfaces.
  - `setAccountEnabledInConfigSection` / `deleteAccountFromConfigSection` (`src/channels/plugins/config-helpers.ts`) are generic helpers for manipulating `cfg.channels.<channel>.accounts.<accountId>` blocks (with careful handling for the default account and optional top-level enablement).
  - `resolveChannelConfigWrites` (`src/channels/plugins/config-writes.ts`) gates whether channel plugins should perform config writes, supporting both a channel-level `configWrites` and per-account overrides (default allow).
  - `resolveChannelDefaultAccountId` (`src/channels/plugins/helpers.ts`) centralizes default account id selection (plugin defaultAccountId override -> first configured -> `default`).
  - `applyAccountNameToChannelSection` / `migrateBaseNameToDefaultAccount` (`src/channels/plugins/setup-helpers.ts`) manage how a channel account `name` is stored in config (top-level vs per-account), with rules to avoid losing names when a channel transitions to multi-account configuration.

- Channel message actions and media limits:
  - `CHANNEL_MESSAGE_ACTION_NAMES` (`src/channels/plugins/message-action-names.ts`) is the canonical action name list used across channel action adapters and schemas.
  - `listChannelMessageActions` / `dispatchChannelMessageAction` (`src/channels/plugins/message-actions.ts`) aggregate supported actions from installed channel plugins and dispatch action handling to the target channel plugin when implemented.
  - `resolveChannelMediaMaxBytes` (`src/channels/plugins/media-limits.ts`) applies a generic precedence for media-size limits: channel/account override (MB) -> `agents.defaults.mediaMaxMb` -> unset.
  - Action adapters live under `src/channels/plugins/actions/*` and bridge tool-level action names into provider-specific implementations:
    - Telegram (`src/channels/plugins/actions/telegram.ts`): gates actions via `channels.telegram.actions`, supports inline buttons only when enabled per account, and delegates to `handleTelegramAction` (agent tool implementation).
    - Signal (`src/channels/plugins/actions/signal.ts`): intentionally does not handle `send` (outbound owns it); reaction actions are gated both by `channels.signal.reactionLevel` (must enable agent reactions) and `channels.signal.actions.reactions` (backward-compatible action gate), and group reactions require target-author attribution.
    - Discord (`src/channels/plugins/actions/discord.ts` + `src/channels/plugins/actions/discord/handle-action*.ts`): exposes a broad surface of message/admin actions gated by `channels.discord.actions` (with several high-risk categories default-off in the gate), and maps the normalized action params into `handleDiscordAction` calls (agent tool implementation).
    - Slack (`src/channels/plugins/slack.actions.ts`): exposes message/reaction/pin/member/emoji actions gated by per-account or global `channels.slack.actions`; it threads sends via `threadId`/`replyTo` and delegates to `handleSlackAction` (agent tool implementation).
  - BlueBubbles action catalog: `src/channels/plugins/bluebubbles-actions.ts`
    - Defines the BlueBubbles action names and gate keys, including which actions are group-only and which are marked unsupported on macOS 26 (used by higher-level surfaces to hide/guard actions in the message tool).

- Status snapshots and status issues:
  - `buildChannelAccountSnapshot` (`src/channels/plugins/status.ts`) produces a `ChannelAccountSnapshot` for an account, delegating to `plugin.status.buildAccountSnapshot` when provided and otherwise falling back to basic `enabled/configured` detection via the config adapter.
  - Status issue collectors live under `src/channels/plugins/status-issues/*` and convert per-channel `status --probe` / `audit` summaries into actionable `ChannelStatusIssue` entries. Examples:
    - Discord: flags missing Message Content intent and per-channel permission audit failures, preserving match metadata (`matchKey`/`matchSource`). (`src/channels/plugins/status-issues/discord.ts`)
    - Telegram: warns about privacy-mode vs unmentioned-group configs and surfaces group membership probe failures. (`src/channels/plugins/status-issues/telegram.ts`)
    - BlueBubbles: reports unconfigured accounts and probe/server reachability failures. (`src/channels/plugins/status-issues/bluebubbles.ts`)

- Pairing helpers:
  - Pairing is a per-channel feature declared via `plugin.pairing` (`ChannelPairingAdapter`).
  - `listPairingChannels` and `resolvePairingChannel` (`src/channels/plugins/pairing.ts`) enumerate supported pairing channels and validate/normalize user input against the installed plugin set.
  - `notifyPairingApproved` invokes the channel-specific approval notifier when available (extensions can pass a pairing adapter directly to bypass registry lookups).
  - `PAIRING_APPROVED_MESSAGE` (`src/channels/plugins/pairing-message.ts`) is the standard DM text used to confirm approval.
  - Pairing store and allowFrom persistence (`src/pairing/pairing-store.ts`):
    - Stores per-channel pending pairing requests and a per-channel allowFrom list under the credentials/OAuth directory (resolved via `resolveStateDir` + `resolveOAuthDir`).
    - File names are `${channel}-pairing.json` and `${channel}-allowFrom.json`, with the channel id sanitized via `safeChannelKey` to prevent path traversal.
    - Concurrency and durability:
      - Files are protected with `proper-lockfile` (retry/backoff, stale locks) to avoid concurrent writers.
      - Writes are atomic: write temp file, chmod `0600`, then rename into place; parent dir is created with mode `0700`.
    - Pending request policy:
      - Default TTL is 1 hour (`PAIRING_PENDING_TTL_MS`); default max pending is 3 (`PAIRING_PENDING_MAX`).
      - Listing requests prunes expired entries, caps to max pending (keeping most-recently-seen), and sorts by `createdAt`.
      - Upserting reuses the existing code for a given id (and refreshes `lastSeenAt`). If the store is at the max pending cap, it returns `{ code: "", created: false }`.
      - Codes are 8 chars from a human-friendly alphabet that avoids ambiguous characters like `0/O` and `1/I`; generation retries to avoid collisions.
    - Approval:
      - `approveChannelPairingCode` removes the matching pending request and adds the request `id` to the allowFrom store via `addChannelAllowFromStoreEntry`.
      - allowFrom entries are normalized using the channel pairing adapter `normalizeAllowEntry` (when provided) and reject empty strings and `"*"` (so the persisted allowFrom store is always explicit ids).
  - Pairing messages:
    - `buildPairingReply` (`src/pairing/pairing-messages.ts`) formats the DM pairing reply text and prints an `openclaw pairing approve ...` command using `formatCliCommand`, which includes `--profile <name>` when `OPENCLAW_PROFILE` is set (tested in `src/pairing/pairing-messages.test.ts`).
    - `resolvePairingIdLabel` (`src/pairing/pairing-labels.ts`) reads the channel pairing adapter `idLabel` to format sender id lines (default: `"userId"`).

- Onboarding types and shared prompts:
  - Channel CLI onboarding is standardized via `ChannelOnboardingAdapter` (`src/channels/plugins/onboarding-types.ts`), which exposes `getStatus` + `configure` plus optional DM policy wiring and disable hooks.
  - `promptAccountId` (`src/channels/plugins/onboarding/helpers.ts`) handles selecting an existing account id or creating a new one (account ids are normalized via `normalizeAccountId`).
  - `promptChannelAccessConfig` (`src/channels/plugins/onboarding/channel-access.ts`) provides shared prompting for allowlist/open/disabled policies and allowlist entry parsing/formatting.
  - Channel-specific onboarding adapters:
    - Telegram (`src/channels/plugins/onboarding/telegram.ts`) configures bot tokens (supports env var usage for the default account) and can resolve allowlist usernames to numeric user ids via Bot API `getChat` when a token is available.
    - Slack (`src/channels/plugins/onboarding/slack.ts`) guides socket-mode token setup, can resolve DM allowlists to user ids and channel allowlists to channel ids when tokens are present, and writes `groupPolicy` plus channel allowlists accordingly.
    - Discord (`src/channels/plugins/onboarding/discord.ts`) configures bot tokens and can resolve allowlisted guild/channel entries into ids/slugs, writing them into `channels.discord.guilds.*.channels` config.
    - Signal (`src/channels/plugins/onboarding/signal.ts`) detects (and optionally installs) `signal-cli`, sets the bot number and cli path, and normalizes allowlists across E.164 and UUID forms.
    - iMessage (`src/channels/plugins/onboarding/imessage.ts`) detects `imsg`, records the CLI path, and supports allowlisting by handle or chat identifiers (`chat_id:`/`chat_guid:`/etc).

- Config-backed directory lists:
  - `src/channels/plugins/directory-config.ts` derives directory entries (peers/groups) from configured allowlists and per-channel config blocks as a lightweight fallback when live directory queries are unavailable.
  - It normalizes ids into target-like strings (e.g. Slack `user:U123`, Discord `channel:123`, Telegram `@username` or numeric ids) and supports query/limit filtering.

- Outbound adapters (channel plugins):
  - Outbound delivery is modeled as a per-channel `ChannelOutboundAdapter` (`deliveryMode` is `direct`, `gateway`, or `hybrid`).
  - `loadChannelOutboundAdapter` (`src/channels/plugins/outbound/load.ts`) loads the outbound adapter from the active plugin registry with a per-registry cache, keeping outbound sends cheap to import compared to full plugin modules.
  - Telegram outbound (`src/channels/plugins/outbound/telegram.ts`):
    - Uses markdown-to-HTML chunking (`markdownToTelegramHtmlChunks`) and sends with `textMode="html"`.
    - Parses numeric `replyToId` and `threadId`.
    - Supports `payload.channelData.telegram.buttons` and will attach buttons only to the first media item when sending multiple media URLs.
  - Slack outbound (`src/channels/plugins/outbound/slack.ts`) threads replies by preferring `replyToId` and falling back to `threadId` (stringified) so tool-delivery stays inside threads.
  - Feishu outbound (`src/channels/plugins/outbound/feishu.ts`) chunks markdown (2000 chars) and selects the Feishu receive-id type (`open_id`/`union_id`/`chat_id`) based on id prefixes (ou_/on_/else).
  - Signal and iMessage outbound (`src/channels/plugins/outbound/signal.ts`, `src/channels/plugins/outbound/imessage.ts`) reuse `resolveChannelMediaMaxBytes` to enforce per-channel/per-account media caps.
  - WhatsApp outbound (`src/channels/plugins/outbound/whatsapp.ts`):
    - Delivery is via gateway (uses the WhatsApp Web provider listener).
    - `resolveTarget` enforces allowlist semantics for implicit/heartbeat sends: when `allowFrom` is a strict list (no `*`), implicit sends fall back to `allowFrom[0]` unless the explicit target is allowed; explicit sends accept the normalized target.
    - Polls are sent via `sendPollWhatsApp` with verbose logging tied to global verbosity.

- Target normalization helpers (channel plugins): `src/channels/plugins/normalize/*`
  - Each channel provides `normalize<X>MessagingTarget` and `looksLike<X>TargetId` helpers for turning user input into canonical `channel:<kind>:<id>` style targets and for deciding whether a string likely represents an id.
  - Telegram normalization supports `tg:`/`telegram:` prefixes and `t.me/<user>` links, canonicalizing to `telegram:@user` or `telegram:<id>` (`src/channels/plugins/normalize/telegram.ts`).
  - Slack and Discord normalization delegate to their target parsers with a default kind of `channel` for bare ids, to keep routing stable across tool actions (`src/channels/plugins/normalize/slack.ts`, `src/channels/plugins/normalize/discord.ts`).
  - iMessage normalization preserves explicit service prefixes (`imessage:`/`sms:`/`auto:`) for handle targets but drops them for chat-guid style targets (`chat_id:`/`chat_guid:`/etc) (`src/channels/plugins/normalize/imessage.ts`).
  - Signal normalization supports `group:` and `username:` targets and recognizes UUID formats (including compact UUIDs) used by signal-cli (`src/channels/plugins/normalize/signal.ts`).

- Targets and session bookkeeping:
  - Target primitives live in `src/channels/targets.ts` (normalized `kind:id` strings plus helpers that validate ids and enforce kind constraints).
  - `recordInboundSession` (`src/channels/session.ts`) records inbound session metadata and (optionally) updates the session store last-route delivery context, so outbound sends can default to the last known destination.

- Labeling and sender identity hygiene:
  - `validateSenderIdentity` (`src/channels/sender-identity.ts`) enforces that non-direct chats have some sender identity present, and validates `SenderE164` (`+<digits>`) plus `SenderUsername` formatting (no `@` prefix, no whitespace).
  - `resolveSenderLabel` (`src/channels/sender-label.ts`) picks a human-friendly label (prefer name/username/tag, append `(e164|id)` when it adds information).
  - `resolveConversationLabel` (`src/channels/conversation-label.ts`) resolves a stable chat label from explicit labels, thread labels, or group subject/channel names; it appends a synthetic `id:<id>` suffix for numeric ids and WhatsApp-style `@g.us` ids but avoids doing so for `#rooms`/`@channels`.

- Mention and control-command gating:
  - `resolveMentionGating` (`src/channels/mention-gating.ts`) decides whether a group message should be skipped when a mention is required (it treats explicit mentions, implicit mentions, and authorized bypasses as equivalent for "effective mention").
  - `resolveMentionGatingWithBypass` supports a common bypass rule: in groups with mention gating enabled, an authorized control command can bypass mention requirements when there are no other mentions.
  - `resolveControlCommandGate` (`src/channels/command-gating.ts`) blocks unauthorized control commands when `allowTextCommands` is enabled; authorization is determined by aggregating per-channel authorizers and an optional `modeWhenAccessGroupsOff` defaulting to allow.

- Reply prefix context:
  - `createReplyPrefixContext` (`src/channels/reply-prefix.ts`) resolves the effective `messages.responsePrefix` for a given agent + (optional) channel/account, and provides a mutable `ResponsePrefixContext` object that is updated when the model is selected (provider/model/thinkingLevel) so prefix templates can include those details.

- Acknowledgements, typing, and location helpers:
  - `shouldAckReaction` and `shouldAckReactionForWhatsApp` (`src/channels/ack-reactions.ts`) decide whether to add an "ack reaction" based on scope (direct vs group), mention gating, and WhatsApp group activation rules; `removeAckReactionAfterReply` can remove the reaction after a successful reply.
  - `createTypingCallbacks` (`src/channels/typing.ts`) wraps provider typing indicators so `start` is best-effort and `stop` is called on idle when available, with centralized error reporting.
  - `formatLocationText` / `toLocationContext` (`src/channels/location.ts`) normalize inbound location payloads and generate a consistent text/context representation (pin vs place vs live).

- Channel docks and lightweight shared behavior: `src/channels/dock.ts`
  - `DOCKS` is the core channel "capabilities + behavior" table used by shared code paths (capabilities, allowFrom resolution/formatting, group mention/tool policy adapters, mention strip patterns, threading defaults, chunk limits, and streaming coalesce defaults).
  - Plugin channels are included by scanning the active plugin registry and building a dock view from the plugin surface (avoids importing heavy channel implementations directly).
  - `listChannelDocks()` merges core + plugin docks and orders them by channel meta `order` (or built-in order), then by id.
  - `getChannelDock(id)` returns a core dock when available or a plugin-derived dock otherwise.

- Channel logging helpers: `src/channels/logging.ts`
  - Small helpers to emit consistent operator-facing logs for inbound drops, typing failures, and ack cleanup failures.

- Web channel entrypoint: `src/channels/web/index.ts`
  - A thin re-export surface for WhatsApp Web helpers (re-exported from `src/channel-web.ts`) used by consumers that import from the channels namespace.
