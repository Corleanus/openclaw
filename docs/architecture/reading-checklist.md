# Deep Reading Checklist

Last updated: 2026-02-09

This is a tracking checklist for a truly exhaustive pass. Mark items as you finish reading and understanding them.

## src/
- [ ] src/acp/
- [ ] src/agents/
- [ ] src/auto-reply/
- [ ] src/browser/
- [ ] src/canvas-host/
- [x] src/channels/
- [ ] src/cli/
- [ ] src/commands/
- [ ] src/compat/
- [ ] src/config/
- [x] src/cron/
- [ ] src/daemon/
- [ ] src/discord/
- [ ] src/docs/
- [ ] src/feishu/
- [ ] src/gateway/
- [ ] src/hooks/
- [ ] src/imessage/
- [ ] src/infra/
- [ ] src/line/
- [ ] src/link-understanding/
- [ ] src/logging/
- [ ] src/macos/
- [ ] src/markdown/
- [ ] src/media/
- [ ] src/media-understanding/
- [ ] src/memory/
- [x] src/node-host/
- [x] src/pairing/
- [x] src/plugins/
- [x] src/plugin-sdk/
- [ ] src/process/
- [ ] src/providers/
- [x] src/routing/
- [ ] src/scripts/
- [ ] src/security/
- [x] src/sessions/
- [ ] src/shared/
- [ ] src/signal/
- [ ] src/slack/
- [ ] src/telegram/
- [ ] src/terminal/
- [ ] src/test-helpers/
- [ ] src/test-utils/
- [x] src/tts/
- [ ] src/tui/
- [ ] src/types/
- [ ] src/utils/
- [x] src/web/
- [x] src/whatsapp/
- [ ] src/wizard/

### Partial Progress Notes

These are file-level checkpoints while `src/*` directories are still in progress.

src/routing (complete):
- [x] src/routing/session-key.ts
- [x] src/routing/bindings.ts
- [x] src/routing/resolve-route.ts
- [x] src/routing/resolve-route.test.ts

src/sessions (complete):
- [x] src/sessions/session-key-utils.ts
- [x] src/sessions/send-policy.ts + src/sessions/send-policy.test.ts
- [x] src/sessions/session-label.ts
- [x] src/sessions/transcript-events.ts
- [x] src/sessions/model-overrides.ts
- [x] src/sessions/level-overrides.ts

src/pairing (complete):
- [x] src/pairing/pairing-labels.ts
- [x] src/pairing/pairing-messages.ts + src/pairing/pairing-messages.test.ts
- [x] src/pairing/pairing-store.ts + src/pairing/pairing-store.test.ts

src/channels (complete):
- [x] src/channels/chat-type.ts + src/channels/chat-type.test.ts
- [x] src/channels/registry.ts + src/channels/registry.test.ts
- [x] src/channels/channel-config.ts + src/channels/channel-config.test.ts
- [x] src/channels/allowlist-match.ts
- [x] src/channels/allowlists/resolve-utils.ts
- [x] src/channels/targets.ts + src/channels/targets.test.ts
- [x] src/channels/session.ts
- [x] src/channels/sender-identity.ts + src/channels/sender-identity.test.ts
- [x] src/channels/sender-label.ts
- [x] src/channels/conversation-label.ts + src/channels/conversation-label.test.ts
- [x] src/channels/mention-gating.ts + src/channels/mention-gating.test.ts
- [x] src/channels/command-gating.ts + src/channels/command-gating.test.ts
- [x] src/channels/reply-prefix.ts
- [x] src/channels/ack-reactions.ts + src/channels/ack-reactions.test.ts
- [x] src/channels/typing.ts + src/channels/typing.test.ts
- [x] src/channels/location.ts + src/channels/location.test.ts
- [x] src/channels/dock.ts
- [x] src/channels/logging.ts
- [x] src/channels/web/index.ts + src/channels/web/index.test.ts

src/agents/tools (subset):
- [x] src/agents/tools/image-tool.ts + src/agents/tools/image-tool.helpers.ts + src/agents/tools/image-tool.test.ts
- [x] src/agents/tools/browser-tool.ts + src/agents/tools/browser-tool.schema.ts + src/agents/tools/browser-tool.test.ts
- [x] src/agents/tools/web-fetch.ts + src/agents/tools/web-fetch-utils.ts + src/agents/tools/web-fetch.ssrf.test.ts + src/agents/tools/web-tools.fetch.test.ts + src/agents/tools/web-tools.readability.test.ts
- [x] src/agents/tools/web-search.ts + src/agents/tools/web-search.test.ts + src/agents/tools/web-tools.enabled-defaults.test.ts
- [x] src/agents/tools/message-tool.ts + src/agents/tools/message-tool.test.ts
- [x] src/agents/tools/gateway-tool.ts + src/agents/tools/gateway.ts + src/agents/tools/gateway.test.ts + src/agents/openclaw-gateway-tool.test.ts
- [x] src/agents/tools/cron-tool.ts + src/agents/tools/cron-tool.test.ts
- [x] src/agents/tools/tts-tool.ts
- [x] src/agents/tools/nodes-tool.ts + src/agents/tools/nodes-utils.ts
- [x] src/agents/tools/canvas-tool.ts
- [x] src/agents/tools/memory-tool.ts + src/agents/tools/memory-tool.*.test.ts (and direct deps: src/agents/memory-search.ts, src/memory/search-manager.ts, src/memory/backend-config.ts)
- [x] Sessions tools + subagent announce plumbing:
  - src/agents/tools/sessions-list-tool.ts + src/agents/tools/sessions-list-tool.gating.test.ts
  - src/agents/tools/sessions-history-tool.ts
  - src/agents/tools/sessions-send-tool.ts + src/agents/tools/sessions-send-tool.a2a.ts + src/agents/tools/sessions-send-tool.gating.test.ts
  - src/agents/tools/sessions-spawn-tool.ts
  - src/agents/tools/sessions-helpers.ts + src/agents/tools/sessions-helpers.test.ts
  - src/agents/tools/sessions-send-helpers.ts + src/agents/tools/sessions-announce-target.ts + src/agents/tools/agent-step.ts
  - src/agents/subagent-registry.ts + src/agents/subagent-registry.store.ts
  - src/agents/subagent-announce.ts + src/agents/subagent-announce-queue.ts
- [x] src/agents/tools/telegram-actions.ts + src/agents/tools/telegram-actions.test.ts (and direct deps: src/telegram/send.ts, src/telegram/token.ts, src/telegram/inline-buttons.ts, src/telegram/reaction-level.ts, src/telegram/sticker-cache.ts)
- [x] src/agents/tools/slack-actions.ts + src/agents/tools/slack-actions.test.ts (and direct deps: src/slack/accounts.ts, src/slack/actions.ts, src/slack/targets.ts, src/slack/send.ts, src/slack/token.ts)
- [x] src/agents/tools/discord-actions.ts + src/agents/tools/discord-actions-*.ts + src/agents/tools/discord-actions*.test.ts (and direct deps under src/discord/* as needed)

src/agents/skills (subset):
- [x] src/agents/skills.ts + src/agents/skills/* + src/agents/skills-*.ts + related tests (skill discovery/precedence, eligibility gating, prompt/snapshot build, command spec generation, watcher + snapshot versioning, sandbox skill mirroring, status + install helpers).

src/agents/session-hygiene (subset):
- [x] src/agents/session-write-lock.ts + src/agents/session-write-lock.test.ts
- [x] src/agents/session-file-repair.ts + src/agents/session-file-repair.test.ts
- [x] src/agents/session-transcript-repair.ts + src/agents/session-transcript-repair.test.ts
- [x] src/agents/session-tool-result-guard.ts + src/agents/session-tool-result-guard.test.ts
- [x] src/agents/session-tool-result-guard-wrapper.ts + src/agents/session-tool-result-guard.tool-result-persist-hook.test.ts
- [x] src/agents/session-slug.ts + src/agents/session-slug.test.ts

src/agents/auth-profiles (subset):
- [x] src/agents/auth-profiles.ts + src/agents/auth-profiles/* + src/agents/model-auth.ts + src/agents/cli-credentials.ts
- [x] Auth profile tests:
  - src/agents/auth-profiles.*.test.ts
  - src/agents/auth-profiles/*.test.ts
  - src/agents/pi-embedded-runner.run-embedded-pi-agent.auth-profile-rotation.test.ts

src/agents/models (subset):
- [x] Model catalog + scanning:
  - src/agents/model-catalog.ts + src/agents/model-catalog.test.ts
  - src/agents/model-scan.ts + src/agents/model-scan.test.ts
  - src/agents/pi-model-discovery.ts
- [x] Selection + compat:
  - src/agents/model-selection.ts + src/agents/model-selection.test.ts
  - src/agents/model-compat.ts
- [x] Fallback and failover:
  - src/agents/model-fallback.ts + src/agents/model-fallback.test.ts
  - src/agents/failover-error.ts
- [x] models.json generation and implicit providers:
  - src/agents/models-config.ts
  - src/agents/models-config.providers.ts
  - src/agents/models-config.*.test.ts
  - src/agents/models-config.providers.*.test.ts
  - src/agents/synthetic-models.ts

src/infra/net (subset):
- [x] src/infra/net/fetch-guard.ts + src/infra/net/ssrf.ts + src/infra/net/ssrf.pinning.test.ts

src/infra/device identity and pairing (subset):
- [x] src/infra/device-identity.ts
- [x] src/infra/device-auth-store.ts
- [x] src/infra/device-pairing.ts + src/infra/device-pairing.test.ts
- [x] src/infra/node-pairing.ts
- [x] src/infra/gateway-lock.ts + src/infra/gateway-lock.test.ts

src/infra/exec approvals (subset):
- [x] src/infra/exec-approvals.ts + src/infra/exec-approvals.test.ts
- [x] src/infra/exec-approval-forwarder.ts + src/infra/exec-approval-forwarder.test.ts

src/infra/heartbeats (subset):
- [x] src/infra/heartbeat-runner.ts
- [x] src/infra/heartbeat-runner.returns-default-unset.test.ts
- [x] src/infra/heartbeat-runner.scheduler.test.ts
- [x] src/infra/heartbeat-runner.sender-prefers-delivery-target.test.ts
- [x] src/infra/heartbeat-runner.respects-ackmaxchars-heartbeat-acks.test.ts
- [x] src/infra/heartbeat-visibility.ts + src/infra/heartbeat-visibility.test.ts
- [x] src/infra/heartbeat-wake.ts
- [x] src/infra/heartbeat-events.ts
- [x] src/infra/system-events.ts + src/infra/system-events.test.ts

src/infra/updates and restart (subset):
- [x] src/infra/update-channels.ts
- [x] src/infra/update-check.ts + src/infra/update-check.test.ts
- [x] src/infra/update-startup.ts + src/infra/update-startup.test.ts
- [x] src/infra/update-global.ts
- [x] src/infra/update-runner.ts + src/infra/update-runner.test.ts
- [x] src/infra/restart.ts + src/infra/restart.test.ts
- [x] src/infra/restart-sentinel.ts + src/infra/restart-sentinel.test.ts

src/cli/updates and daemon lifecycle (subset):
- [x] src/cli/update-cli.ts
- [x] src/cli/update-cli.test.ts
- [x] src/cli/daemon-cli/lifecycle.ts
- [x] src/cli/gateway-cli/run-loop.ts

src/daemon (service adapters subset):
- [x] src/daemon/service.ts
- [x] src/daemon/service-env.ts
- [x] src/daemon/constants.ts
- [x] src/daemon/paths.ts
- [x] src/daemon/launchd.ts
- [x] src/daemon/systemd.ts
- [x] src/daemon/schtasks.ts

src/gateway (ops/update subset):
- [x] src/gateway/server-methods/update.ts
- [x] src/gateway/server-methods/config.ts (config.apply/config.patch restart + sentinel path)
- [x] src/gateway/server-reload-handlers.ts (SIGUSR1 restart policy updates)
- [x] src/gateway/server-restart-sentinel.ts

src/macos (ops subset):
- [x] src/macos/gateway-daemon.ts (SIGUSR1 restart loop)

src/auto-reply/reply (subset):
- [x] src/auto-reply/reply/session-updates.ts

src/auto-reply (subset):
- [x] src/auto-reply/tokens.ts
- [x] src/auto-reply/heartbeat.ts + src/auto-reply/heartbeat.test.ts
- [x] src/auto-reply/envelope.ts + src/auto-reply/envelope.test.ts
- [x] src/auto-reply/dispatch.ts
- [x] src/auto-reply/types.ts
- [x] src/auto-reply/templating.ts
- [x] src/auto-reply/commands-registry.types.ts
- [x] src/auto-reply/commands-registry.data.ts
- [x] src/auto-reply/commands-registry.ts + src/auto-reply/commands-registry.test.ts
- [x] src/auto-reply/commands-args.ts
- [x] src/auto-reply/thinking.ts + src/auto-reply/thinking.test.ts
- [x] src/auto-reply/command-detection.ts
- [x] src/auto-reply/send-policy.ts
- [x] src/auto-reply/group-activation.ts
- [x] src/auto-reply/command-auth.ts
- [x] src/auto-reply/skill-commands.ts + src/auto-reply/skill-commands.test.ts
- [x] src/auto-reply/status.ts
- [x] src/auto-reply/command-control.test.ts

src/auto-reply/reply commands (subset):
- [x] src/auto-reply/reply/commands.ts + src/auto-reply/reply/commands-types.ts
- [x] src/auto-reply/reply/commands-context.ts
- [x] src/auto-reply/reply/commands-core.ts
- [x] src/auto-reply/reply/commands-plugin.ts
- [x] src/auto-reply/reply/commands-bash.ts
- [x] src/auto-reply/reply/commands-activation+send+usage+restart+stop+abort: src/auto-reply/reply/commands-session.ts
- [x] src/auto-reply/reply/commands-info.ts + src/auto-reply/reply/commands-info.test.ts
- [x] src/auto-reply/reply/commands-config.ts
- [x] src/auto-reply/reply/commands-compact.ts
- [x] src/auto-reply/reply/commands-approve.ts
- [x] src/auto-reply/reply/commands-allowlist.ts
- [x] src/auto-reply/reply/commands-models.ts
- [x] src/auto-reply/reply/commands-subagents.ts
- [x] src/auto-reply/reply/commands-tts.ts
- [x] reply command tests (subset):
  - [x] src/auto-reply/reply/commands.test.ts
  - [x] src/auto-reply/reply/commands-parsing.test.ts
  - [x] src/auto-reply/reply/commands-policy.test.ts

src/config (seams subset; in progress):
- [x] src/config/config.ts (re-exports and public API surface)
- [x] src/config/paths.ts (state/config path resolution, legacy migration of dir/filenames, oauth dir)
- [x] src/config/paths.test.ts
- [x] src/config/io.ts (config IO pipeline, caching, backup/rotation writes)
- [x] src/config/io.compat.test.ts (config path resolution compat + explicit OPENCLAW_CONFIG_PATH)
- [x] src/config/includes.ts + src/config/includes.test.ts ($include deep merge semantics + depth/cycle limits)
- [x] src/config/env-vars.ts + src/config/config.env-vars.test.ts (config.env application into process.env; never overrides)
- [x] src/config/env-substitution.ts + src/config/env-substitution.test.ts (${VAR} substitution rules + escaping)
- [x] src/config/validation.ts (Zod validation + plugin/channel id validation + avatar path validation)
- [x] src/config/schema.ts + src/config/schema.test.ts (UI schema/hints generation + plugin/channel schema merging)
- [x] src/config/defaults.ts (message/logging/session/agent/context pruning/compaction/model defaults)
- [x] src/config/runtime-overrides.ts + src/config/runtime-overrides.test.ts (runtime-only config overrides; prototype-pollution safe)
- [x] src/config/legacy.ts + src/config/legacy-migrate.ts + src/config/legacy.rules.ts + src/config/legacy.shared.ts + src/config/legacy.migrations.part-*.ts

src/cli (seams subset; in progress):
- [x] src/entry.ts (CLI respawn + Windows argv normalization + profile env bootstrap)
- [x] src/cli/run-main.ts (route-first + Commander parse + plugin CLI registration timing)
- [x] src/cli/argv.ts + src/cli/argv.test.ts (argv scanning helpers + parseArgv normalization)
- [x] src/cli/route.ts (route-first fast path gate)
- [x] src/cli/program/build-program.ts
- [x] src/cli/program/command-registry.ts (route-first registry for status/health/sessions/etc)
- [x] src/cli/program/register.subclis.ts (lazy subcommands contract)
- [x] src/cli/program/config-guard.ts (config snapshot gate + legacy issues hinting)
- [x] src/cli/program/preaction.ts (banner/verbosity/config gate + plugin load trigger)

src/gateway/protocol (seams subset; in progress):
- [x] src/gateway/protocol/schema/protocol-schemas.ts (ProtocolSchemas registry + PROTOCOL_VERSION)
- [x] src/gateway/protocol/schema/frames.ts (ConnectParams/HelloOk/frames schemas)
- [x] src/gateway/protocol/schema.ts (schema re-export surface)
- [x] src/gateway/protocol/index.ts (AJV compilers for request/response/event validation)
- [x] src/gateway/server-methods-list.ts (methods inventory + events list)
- [x] src/gateway/server-runtime-config.ts (bind/auth/tailscale safety invariants)
- [x] src/gateway/server-http.ts (HTTP mux routing order + upgrade handler)
- [x] src/gateway/server-runtime-state.ts (HTTP server(s) + ws server creation + broadcaster/chat registries)
- [x] src/gateway/server-startup.ts (sidecars: browser control, gmail watcher, hooks, channels, plugin services)
- [x] src/gateway/config-reload.ts (config watcher + diff/rules + hot-reload vs restart)
- [x] src/gateway/server-close.ts (shutdown event + ws close + sidecar teardown)
- [x] src/gateway/server.impl.ts (top-level boot wiring + config write-on-start rules)

src/security (subset):
- [x] src/security/external-content.ts + src/security/external-content.test.ts

src/discord (subset):
- [x] src/discord/send.ts + src/discord/send.*.ts + src/discord/send.types.ts
- [x] src/discord/targets.ts
- [x] src/discord/monitor/gateway-registry.ts + src/discord/monitor/presence-cache.ts
- [x] Discord provider monitor and allowlists (subset):
  - src/discord/accounts.ts
  - src/discord/probe.ts
  - src/discord/audit.ts
  - src/discord/directory-live.ts
  - src/discord/resolve-channels.ts
  - src/discord/resolve-users.ts
  - src/discord/monitor.ts + src/discord/monitor/provider.ts
  - src/discord/monitor/allow-list.ts
  - src/discord/monitor/message-handler.ts + src/discord/monitor/message-handler.preflight.ts + src/discord/monitor/message-handler.process.ts
  - src/discord/monitor/threading.ts + src/discord/monitor/message-utils.ts
  - src/discord/monitor/reply-context.ts + src/discord/monitor/reply-delivery.ts
  - src/discord/monitor/listeners.ts + src/discord/monitor/typing.ts + src/discord/monitor/system-events.ts + src/discord/monitor/sender-identity.ts
  - src/discord/monitor/native-command.ts
  - src/discord/monitor/exec-approvals.ts + src/discord/monitor/exec-approvals.test.ts
  - src/discord/monitor/message-handler.inbound-contract.test.ts + src/discord/monitor/message-handler.process.test.ts + src/discord/monitor/threading.test.ts

src/web (complete):
- [x] src/web/inbound.ts (public re-exports for inbound monitor + extract helpers)
- [x] src/web/accounts.ts (WhatsApp account config + authDir resolution)
- [x] src/web/accounts.test.ts (accountId sanitization prevents path traversal / special chars)
- [x] src/web/accounts.whatsapp-auth.test.ts (WhatsApp auth dir detection + legacy creds handling)
- [x] src/web/active-listener.ts (active per-account web listener registry)
- [x] src/web/auth-store.ts (creds.json + creds.json.bak restore/delete + identity read)
- [x] src/web/session.ts (Baileys socket + safe creds persistence + error formatting)
- [x] src/web/session.test.ts (creds save queue + backup rotation + error formatting)
- [x] src/web/login.ts + src/web/login-qr.ts (interactive login + QR login state machine)
- [x] src/web/login.test.ts + src/web/login.coverage.test.ts + src/web/login-qr.test.ts
- [x] src/web/logout.test.ts
- [x] src/web/qr-image.ts (QR -> PNG data URL)
- [x] src/web/qr-image.test.ts
- [x] src/web/vcard.ts (strict vCard parsing used for contact placeholders)
- [x] src/web/outbound.ts + src/web/outbound.test.ts (send text/media/polls/reactions via active listener)
- [x] src/web/media.ts (fetch + optimize media with caps, SSRF policy hooks)
- [x] src/web/media.test.ts (caps + optimization rules + SSRF pinning tests)
- [x] src/web/reconnect.ts (heartbeat + reconnect backoff policy)
- [x] src/web/reconnect.test.ts
- [x] src/web/inbound/monitor.ts (Baileys inbound ingest + dedupe + media download + debounced flush)
- [x] src/web/inbound/access-control.ts (DM policy + pairing reply + group policy gating + read receipts)
- [x] src/web/inbound/access-control.pairing-history.test.ts
- [x] src/web/inbound/extract.ts (body/media/location/reply-context extraction + contact placeholders)
- [x] src/web/inbound/media.ts (downloadMediaMessage wrapper)
- [x] src/web/inbound/send-api.ts (active socket send API: sendMessage/sendPoll/sendReaction/sendComposingTo)
- [x] src/web/inbound/types.ts + src/web/inbound/dedupe.ts
- [x] src/web/inbound.test.ts + src/web/inbound.media.test.ts
- [x] src/web/monitor-inbox.blocks-messages-from-unauthorized-senders-not-allowfrom.test.ts
- [x] src/web/monitor-inbox.allows-messages-from-senders-allowfrom-list.test.ts
- [x] src/web/monitor-inbox.captures-media-path-image-messages.test.ts
- [x] src/web/monitor-inbox.streams-inbound-messages.test.ts
- [x] src/web/auto-reply.ts + src/web/auto-reply.impl.ts (public re-exports for web auto-reply + heartbeat helpers)
- [x] src/web/auto-reply/monitor.ts (main loop: status + watchdog + reconnect + system events)
- [x] src/web/auto-reply/deliver-reply.ts (chunking + markdown table conversion + media send + fallback)
- [x] src/web/auto-reply/constants.ts (DEFAULT_WEB_MEDIA_BYTES)
- [x] src/web/auto-reply/heartbeat-runner.ts (WhatsApp heartbeat send loop)
- [x] src/web/auto-reply/loggers.ts (WhatsApp subsystem loggers)
- [x] src/web/auto-reply/mentions.ts (mention detection + self-chat safety)
- [x] src/web/auto-reply/mentions.test.ts
- [x] src/web/auto-reply/types.ts
- [x] src/web/auto-reply/util.ts (elide + Bad MAC / crypto error detection)
- [x] src/web/auto-reply.partial-reply-gating.test.ts
- [x] src/web/auto-reply.typing-controller-idle.test.ts
- [x] src/web/auto-reply.broadcast-groups.broadcasts-sequentially-configured-order.test.ts
- [x] src/web/auto-reply.broadcast-groups.skips-unknown-broadcast-agent-ids-agents-list.test.ts
- [x] src/web/auto-reply.web-auto-reply.compresses-common-formats-jpeg-cap.test.ts
- [x] src/web/auto-reply.web-auto-reply.falls-back-text-media-send-fails.test.ts
- [x] src/web/auto-reply.web-auto-reply.prefixes-body-same-phone-marker-from.test.ts
- [x] src/web/auto-reply.web-auto-reply.reconnects-after-connection-close.test.ts
- [x] src/web/auto-reply.web-auto-reply.requires-mention-group-chats-injects-history-replying.test.ts
- [x] src/web/auto-reply.web-auto-reply.sends-tool-summaries-immediately-responseprefix.test.ts (actually verifies tool summaries are skipped)
- [x] src/web/auto-reply.web-auto-reply.supports-always-group-activation-silent-token-preserves.test.ts
- [x] src/web/auto-reply.web-auto-reply.uses-per-agent-mention-patterns-group-gating.test.ts
- [x] src/web/auto-reply/monitor/on-message.ts (routing + echo suppression + group gating + broadcast fanout)
- [x] src/web/auto-reply/monitor/process-message.ts (envelope + history context + reply dispatch)
- [x] src/web/auto-reply/monitor/process-message.inbound-contract.test.ts
- [x] src/web/auto-reply/monitor/commands.ts (status command detection + mention stripping for commands)
- [x] src/web/auto-reply/monitor/echo.ts (recently-sent echo detector)
- [x] src/web/auto-reply/monitor/group-gating.ts + src/web/auto-reply/monitor/group-activation.ts
- [x] src/web/auto-reply/monitor/group-gating.test.ts
- [x] src/web/auto-reply/monitor/ack-reaction.ts + src/web/auto-reply/monitor/broadcast.ts + src/web/auto-reply/monitor/last-route.ts
- [x] src/web/auto-reply/monitor/group-members.ts (best-effort roster tracking + formatting)
- [x] src/web/auto-reply/monitor/message-line.ts + src/web/auto-reply/monitor/message-line.test.ts
- [x] src/web/auto-reply/monitor/peer.ts (resolve peer id for session routing)
- [x] src/web/auto-reply/session-snapshot.ts + src/web/auto-reply/session-snapshot.test.ts
- [x] src/web/test-helpers.ts (Baileys mocks + loadConfig override helpers)

src/channels/plugins (subset):
- [x] src/channels/plugins/types.ts + src/channels/plugins/types.core.ts + src/channels/plugins/types.adapters.ts + src/channels/plugins/types.plugin.ts
- [x] src/channels/plugins/index.ts + src/channels/plugins/index.test.ts
- [x] src/channels/plugins/load.ts + src/channels/plugins/load.test.ts
- [x] src/channels/plugins/catalog.ts + src/channels/plugins/catalog.test.ts
- [x] src/channels/plugins/helpers.ts
- [x] src/channels/plugins/config-schema.ts
- [x] src/channels/plugins/config-helpers.ts
- [x] src/channels/plugins/channel-config.ts
- [x] src/channels/plugins/config-writes.ts + src/channels/plugins/config-writes.test.ts
- [x] src/channels/plugins/message-action-names.ts
- [x] src/channels/plugins/message-actions.ts
- [x] src/channels/plugins/media-limits.ts
- [x] src/channels/plugins/status.ts
- [x] src/channels/plugins/status-issues/shared.ts
- [x] src/channels/plugins/status-issues/discord.ts
- [x] src/channels/plugins/status-issues/telegram.ts
- [x] src/channels/plugins/status-issues/bluebubbles.ts
- [x] src/channels/plugins/pairing.ts
- [x] src/channels/plugins/pairing-message.ts
- [x] src/channels/plugins/onboarding-types.ts
- [x] src/channels/plugins/onboarding/helpers.ts
- [x] src/channels/plugins/onboarding/channel-access.ts
- [x] src/channels/plugins/onboarding/telegram.ts
- [x] src/channels/plugins/onboarding/slack.ts
- [x] src/channels/plugins/onboarding/discord.ts
- [x] src/channels/plugins/onboarding/signal.ts
- [x] src/channels/plugins/onboarding/imessage.ts
- [x] src/channels/plugins/directory-config.ts + src/channels/plugins/directory-config.test.ts
- [x] src/channels/plugins/outbound/load.ts
- [x] src/channels/plugins/outbound/telegram.ts + src/channels/plugins/outbound/telegram.test.ts
- [x] src/channels/plugins/outbound/discord.ts
- [x] src/channels/plugins/outbound/feishu.ts
- [x] src/channels/plugins/outbound/imessage.ts
- [x] src/channels/plugins/outbound/signal.ts
- [x] src/channels/plugins/outbound/slack.ts
- [x] src/channels/plugins/outbound/whatsapp.ts
- [x] src/channels/plugins/normalize/telegram.ts
- [x] src/channels/plugins/normalize/slack.ts
- [x] src/channels/plugins/normalize/discord.ts
- [x] src/channels/plugins/normalize/feishu.ts
- [x] src/channels/plugins/normalize/imessage.ts + src/channels/plugins/normalize/imessage.test.ts
- [x] src/channels/plugins/normalize/signal.ts + src/channels/plugins/normalize/signal.test.ts
- [x] src/channels/plugins/actions/telegram.ts + src/channels/plugins/actions/telegram.test.ts
- [x] src/channels/plugins/actions/signal.ts + src/channels/plugins/actions/signal.test.ts
- [x] src/channels/plugins/actions/discord.ts + src/channels/plugins/actions/discord.test.ts
- [x] src/channels/plugins/actions/discord/handle-action.ts
- [x] src/channels/plugins/actions/discord/handle-action.guild-admin.ts
- [x] src/channels/plugins/slack.actions.ts + src/channels/plugins/slack.actions.test.ts
- [x] src/channels/plugins/bluebubbles-actions.ts
- [x] src/channels/plugins/allowlist-match.ts
- [x] src/channels/plugins/setup-helpers.ts

src/channels/plugins (WhatsApp subset):
- [x] src/channels/plugins/agent-tools/whatsapp-login.ts (agent tool wrapper around QR login)
- [x] src/channels/plugins/onboarding/whatsapp.ts (wizard onboarding + dmPolicy/allowFrom setup + QR prompt)
- [x] src/channels/plugins/status-issues/whatsapp.ts (status issues for channels status output)
- [x] src/channels/plugins/normalize/whatsapp.ts (target normalization + "looksLike" heuristic)
- [x] src/channels/plugins/whatsapp-heartbeat.ts (pick heartbeat recipients from sessions/allowFrom)
- [x] src/channels/plugins/group-mentions.ts (WhatsApp group requireMention + per-group tool policy helpers)

src/gateway (subset):
- [x] src/gateway/server-methods/web.ts (web.login.start + web.login.wait provider dispatch)

src/gateway (nodes boundary subset):
- [x] src/gateway/node-registry.ts
- [x] src/gateway/node-command-policy.ts
- [x] src/gateway/server-methods/nodes.ts + src/gateway/server-methods/nodes.helpers.ts
- [x] src/gateway/server-node-events.ts + src/gateway/server-node-events-types.ts + src/gateway/server-node-events.test.ts
- [x] src/gateway/server-node-subscriptions.ts + src/gateway/server-node-subscriptions.test.ts
- [x] src/gateway/protocol/schema/nodes.ts
- [x] src/gateway/server.nodes.late-invoke.test.ts
- [x] src/gateway/server/ws-connection.ts (node disconnect cleanup)
- [x] src/gateway/server/ws-connection/message-handler.ts (node connect registration + pairing metadata)
- [x] src/gateway/server-methods.ts (role=node method allowlist)

src/node-host (complete):
- [x] src/node-host/config.ts
- [x] src/node-host/runner.ts + src/node-host/runner.test.ts

apps (nodes wire contract subset):
- [x] apps/shared/OpenClawKit/Sources/OpenClawKit/GatewayNodeSession.swift
- [x] apps/ios/Sources/Model/NodeAppModel.swift
- [x] apps/ios/Sources/Voice/TalkModeManager.swift
- [x] apps/ios/Sources/Chat/IOSGatewayChatTransport.swift
- [x] apps/android/app/src/main/java/ai/openclaw/android/gateway/GatewaySession.kt
- [x] apps/android/app/src/main/java/ai/openclaw/android/NodeRuntime.kt
- [x] apps/macos/Sources/OpenClaw/NodeMode/MacNodeModeCoordinator.swift
- [x] apps/macos/Sources/OpenClaw/NodeMode/MacNodeRuntime.swift
- [x] apps/macos/Sources/OpenClaw/NodePairingApprovalPrompter.swift

src/media (subset):
- [x] src/media/constants.ts
- [x] src/media/parse.ts + src/media/parse.test.ts
- [x] src/media/mime.ts + src/media/mime.test.ts
- [x] src/media/fetch.ts
- [x] src/media/input-files.ts
- [x] src/media/store.ts + src/media/store.test.ts + src/media/store.redirect.test.ts
- [x] src/media/server.ts + src/media/server.test.ts
- [x] src/media/host.ts + src/media/host.test.ts
- [x] src/media/image-ops.ts
- [x] src/web/media.ts (media caps + optimization + SSRF policy)

src/media-understanding (subset):
- [x] src/media-understanding/types.ts + src/media-understanding/defaults.ts
- [x] src/media-understanding/attachments.ts + src/media-understanding/attachments.ssrf.test.ts
- [x] src/media-understanding/scope.ts + src/media-understanding/scope.test.ts
- [x] src/media-understanding/format.ts + src/media-understanding/format.test.ts
- [x] src/media-understanding/resolve.ts + src/media-understanding/resolve.test.ts
- [x] src/media-understanding/concurrency.ts
- [x] src/media-understanding/errors.ts
- [x] src/media-understanding/runner.ts (key invariants: vision skip, auto entries, model selection)
- [x] src/media-understanding/apply.ts + src/media-understanding/apply.test.ts
- [x] src/media-understanding/video.ts
- [x] src/media-understanding/providers/index.ts + src/media-understanding/providers/shared.ts + src/media-understanding/providers/image.ts
- [x] src/media-understanding/providers/openai/* + src/media-understanding/providers/google/* + src/media-understanding/providers/deepgram/* + src/media-understanding/providers/groq/* + src/media-understanding/providers/anthropic/* + src/media-understanding/providers/minimax/*

## extensions/ (bundled plugins)
- [ ] extensions/bluebubbles/
- [ ] extensions/copilot-proxy/
- [ ] extensions/diagnostics-otel/
- [x] extensions/discord/
- [ ] extensions/feishu/
- [ ] extensions/google-antigravity-auth/
- [ ] extensions/googlechat/
- [ ] extensions/google-gemini-cli-auth/
- [ ] extensions/imessage/
- [ ] extensions/line/
- [ ] extensions/llm-task/
- [ ] extensions/lobster/
- [ ] extensions/matrix/
- [ ] extensions/mattermost/
- [ ] extensions/memory-core/
- [ ] extensions/memory-lancedb/
- [ ] extensions/minimax-portal-auth/
- [ ] extensions/msteams/
- [ ] extensions/nextcloud-talk/
- [ ] extensions/nostr/
- [ ] extensions/open-prose/
- [ ] extensions/qwen-portal-auth/
- [ ] extensions/signal/
- [ ] extensions/slack/
- [x] extensions/telegram/
- [ ] extensions/tlon/
- [ ] extensions/twitch/
- [ ] extensions/voice-call/
- [x] extensions/whatsapp/
- [ ] extensions/zalo/
- [ ] extensions/zalouser/

## apps/
- [ ] apps/android/
- [ ] apps/ios/
- [ ] apps/macos/
- [ ] apps/shared/

## ui/
- [ ] ui/

## scripts/
- [ ] scripts/

## packages/
- [ ] packages/

