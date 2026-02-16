# Handoff: Architecture Docs — Senior Developer Map
Date: 2026-02-09
Updated: 2026-02-09

## Goal
An always-correct "senior developer map" of OpenClaw: seam-based playbooks (`docs/architecture/GUIDEBOOK.md`) with owner modules, invariants, test pointers, and change playbooks for every cross-cutting boundary; a code-accurate semantic primer (`docs/architecture/PROJECT_PRIMER.md`); and clean user-facing docs (no personal paths, accurate commands/links/names).

## Doc Hygiene — Done
- [x] Clawdbot -> OpenClaw branding in issue templates, agent workflow (renamed to `update_openclaw.md`), skills docs, railway.mdx deploy link. Remaining `clawdbot` refs are intentional legacy compat (PROJECT_PRIMER state dirs, updating.md shim, formal-models repo name).
- [x] CHANGELOG: removed duplicate entries in 2026.2.2, removed bogus 2026.1.31 section, standardized formatting in 2026.2.2 to `Category:` + `Thanks @name`, fixed malformed PR ref `(#3047)`, fixed `docs/bun.md` -> `docs/install/bun.md`.
- [x] README: fixed broken `docs/mac/permissions.md` -> full docs URL; made Opus recommendation version-agnostic ("Claude Opus").
- [x] SECURITY.md: removed fabricated CVE-2026-21636.
- [x] Telegram docs: removed Node 20 workaround, now says Node 22+ (including zh-CN copy).
- [x] skills/model-usage/SKILL.md: removed unresolved TODO.
- [x] PROJECT_PRIMER.md: build instructions now list both `pnpm build` + `pnpm ui:build`; fixed `src/channel-web.js` -> `.ts` (ESM `.js` specifier kept in parenthetical — technically accurate but could be tightened).
- [x] GUIDEBOOK.md: added 6 missing seams (Models/Providers, Memory, Security/Audit, Hooks, Cron, Logging/Redaction).
- [x] Removed "???" placeholder in exe.dev docs (English + zh-CN).
- [x] Removed `flawd-bot` personal deployment ref from AGENTS.md.

## GUIDEBOOK.md Seam Coverage — Complete

All 23 seams at FULL (owner modules + invariants + explicit test file citations + change playbook):
Config+State, Models+Providers, Memory+Search, Security+Audit, CLI Boot+Routing, Gateway Boot, Gateway Protocol+Schemas, Sessions+Transcripts, Auto-reply Pipeline, Tools+Sandbox, Exec Approvals, Plugins+Extensions, Channels+Delivery, Nodes, Media Pipeline (incl. link understanding subsection), Hooks, Cron, Logging+Redaction, Control UI+Canvas Host, Ops+Updates, Process+Concurrency (new), Terminal+Rendering (new), Browser Control (new).

All 4 supplemental playbooks have invariants + test pointers:
- Add a New Gateway WS Method or Event
- Change WebSocket Connect/Auth/Pairing
- Add a New Channel Plugin
- Add or Change a Slash Command / Directive

### What was done in this session (Phase A):
- [x] Added test file citations to 7 formerly-PARTIAL seams (CLI Boot, Gateway Boot, Gateway Protocol, Tools+Sandbox, Plugins+Extensions, Channels+Delivery, Control UI+Canvas Host)
- [x] Added Core invariants + Primary tests to 4 supplemental playbooks (Gateway WS Method, WS Connect/Auth/Pairing, Channel Plugin, Slash Command/Directive)
- [x] Wrote 3 new seams with full playbooks (Process+Concurrency, Terminal+Rendering, Browser Control) — seam index rows + touch points + invariants + checklists + test pointers
- [x] Added link understanding subsection to Media Pipeline seam (invariants + checklist items 5-6 + test pointer)
- [x] Updated GUIDEBOOK "Current Seam Gaps" section to reflect 23 seams at FULL
- [x] Updated this handoff

## PROJECT_PRIMER.md — Verified Accurate
Spot-checked against source code: file paths, config keys, env vars, CLI behavior all match. No stale references found. Complementary to GUIDEBOOK (PRIMER = deep semantics, GUIDEBOOK = seam contracts).

## User-Facing Docs — Verified Accurate
Sampled 12 files across channels, CLI, concepts, gateway, install. All config keys, CLI flags, env vars, internal links verified correct. No personal paths. Content is current.

## What's Left To Do

### Phase B: Per-provider + per-extension playbooks
**Core providers: DONE.** All 6 core channel providers have playbooks under Channels+Delivery:
- [x] WhatsApp/Web (Baileys socket, QR login, media optimization, reconnection)
- [x] Telegram (Grammy framework, sticker cache, forum/topics, inline buttons, reaction levels)
- [x] Discord (Gateway+REST hybrid, guild permissions, auto-threading, PluralKit)
- [x] Slack (Bolt framework, Socket/HTTP modes, thread_ts resolution, Blocks API slash commands)
- [x] Signal (signal-cli daemon, linked device auth, SSE reconnection, text styles)
- [x] iMessage (imsg CLI bridge, macOS-only, iMessage/SMS routing, no native reactions)

**All extensions: DONE.**
- [x] MS Teams (Azure AD/Bot Framework OAuth, Adaptive Cards, FileConsentCard/Graph uploads, conversation store)
- [x] Voice Call (Twilio/Telnyx/Plivo, call state machine, mu-law audio, OpenAI Realtime STT, barge-in)
- [x] Memory-LanceDB (LanceDB vector backend, OpenAI embeddings, auto-capture/recall, duplicate detection)
- [x] Google Chat (service account auth, JWT webhook verification, Workspace Add-on dual format, multipart media upload)
- [x] Matrix (matrix-bot-sdk, optional E2EE via Rust crypto, m.thread + m.in_reply_to, MSC3381 polls, room config wildcards)
- [x] LINE (@line/bot-sdk Messaging API v3, HMAC-SHA256 webhook, Flex Messages, /card command, rich message directives)
- [x] Feishu (Lark SDK, domain duality feishu.cn/larksuite.com, CardKit streaming, tenant-scoped tokens, Feishu Post format)
- [x] Memory-Core (SQLite+sqlite-vec+FTS5 builtin backend, QMD fallback, multi-provider embeddings, hybrid search)

### Phase C: File-level deep reading (ongoing)
Tracked in `docs/architecture/reading-checklist.md`. ~1,600-1,800 unchecked .ts files across src/, extensions/, apps/, ui/, scripts/, packages/. Incremental, priority-ordered by file count and cross-cutting impact. May refine existing seams but unlikely to produce new ones.

### Polish (lower priority)
- [ ] Decide "Opus 4.5" policy: other docs still reference it, README is version-agnostic
- [ ] Tighten `channel-web.js` ESM parenthetical in PROJECT_PRIMER.md
- [ ] Normalize `dist/` artifact labeling across PROJECT_PRIMER.md
- [ ] Optional: smart punctuation -> ASCII normalization
- [ ] Optional: automated doc-hygiene script for CI (broken refs, stale names, future CVEs, leftover TODOs)

## Context That Won't Be Obvious
- This workspace is not a git repo (`.git` missing); use content-based scans (`rg`, grep) not git diff/blame.
- `docs/zh-CN/**` is generated; don't edit unless explicitly requested. We already made targeted factual fixes (Node 22+ in telegram, "???" in exe-dev).
- CHANGELOG attribution format is consistent within 2026.2.2 (`Thanks @name`) but mixed in older versions — left as historical.
- Remaining `clawdbot` references are intentional: legacy state dirs in PROJECT_PRIMER, compat shim in updating.md, formal-models repo name in CI workflow.
