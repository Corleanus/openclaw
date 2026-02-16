# Media Pipeline
**Parent**: PROJECT_PRIMER.md
**Last Updated**: 2026-02-10

> **Seams:** Media Pipeline

There are three related "media" contracts in core:
1. MEDIA tokens and temporary media hosting (agent/tool output -> shareable URL)
2. Media ingestion/normalization (fetch, detect MIME, optimize images, enforce caps)
3. Media understanding (pre-processing inbound attachments into text for the agent)

### MEDIA Tokens (Output Contract)

- Output can contain `MEDIA:<url-or-path>` lines (often emitted by CLI commands and tools).
- Parsing is strict and security-focused: `splitMediaFromOutput()` (`src/media/parse.ts`) only extracts:
  - `http(s)://...` URLs, and
  - safe local relative paths starting with `./` and containing no `..`.
  Absolute paths and `~` paths are rejected (the token is preserved as text). (`src/media/parse.test.ts`)
- MEDIA tokens inside fenced code blocks are ignored (so examples don't trigger attachment delivery). (`src/media/parse.ts`)
- `[[audio_as_voice]]` is a separate tag that is detected and stripped from the cleaned text. (`src/media/parse.ts`)

### Temporary Media Storage and Hosting

Storage:
- Media is stored under the OpenClaw config dir in a `media/` subdir.
- Default cap is 5MB and the default TTL is 2 minutes; old media is periodically cleaned. (`src/media/store.ts`)
- `saveMediaBuffer()` can embed and sanitize an `originalFilename` into the stored id as `{sanitized}---{uuid}{ext}` to preserve human context while staying filesystem-safe. (`src/media/store.ts`)

Serving:
- `attachMediaRoutes()` serves `GET /media/:id`, validates ids, blocks traversal and symlink escape (`openFileWithinRoot`), enforces TTL/size, and deletes the file after send (best-effort) plus periodic cleanup. (`src/media/server.ts`)

Hosting:
- `ensureMediaHosted()` saves the media and returns a tailnet URL `https://<tailnet-hostname>/media/<id>`.
- It requires the webhook/Funnel server to be running unless `--serve-media` (or equivalent caller option) is used to start a temporary local media server. (`src/media/host.ts`)

Remote fetch + MIME detection:
- `fetchRemoteMedia()` uses SSRF-guarded fetch and enforces `maxBytes` while reading; it tries to infer filename via `Content-Disposition` and MIME via sniffing + extension/header heuristics. (`src/media/fetch.ts`, `src/media/mime.ts`)
- `detectMime()` prefers buffer sniffing but avoids letting generic container types (e.g. ZIP) override specific extension mappings (e.g. XLSX). (`src/media/mime.ts`, `src/media/mime.test.ts`)

### Web Media Ingestion (Caps + Optimization)

`src/web/media.ts` loads media from file paths, `file://` URLs, or http(s) URLs with SSRF policy support.
- Per-kind caps default to: image 6MB, audio 16MB, video 16MB, documents 100MB. (`src/media/constants.ts`)
- Images are optimized by default:
  - GIFs are not optimized (only clamped)
  - HEIC/HEIF can be converted to JPEG
  - PNG alpha preservation uses a PNG-first path and only falls back to JPEG when needed. (`src/web/media.ts`, `src/media/image-ops.ts`)

Image ops backend:
- `src/media/image-ops.ts` uses `sharp` by default, with a macOS/Bun-leaning `sips` backend option.
- EXIF orientation normalization is applied before resize to avoid rotated thumbnails. (`src/media/image-ops.ts`)

### Media Understanding (Inbound Pre-processing)

Goal: turn inbound attachments into text that the agent can reason over.

- Entry point: `applyMediaUnderstanding()` (`src/media-understanding/apply.ts`).
- It:
  - normalizes attachments from `MsgContext` fields (`MediaPath(s)`, `MediaUrl(s)`, `MediaType(s)`)
  - selects attachments per capability (image/audio/video) via a policy (`first/last/path/url` preference, and `first/all` mode) (`src/media-understanding/attachments.ts`)
  - enforces scope rules per sessionKey prefix/channel/chatType (`src/media-understanding/scope.ts`)
  - runs capability-specific understanding with bounded concurrency (`src/media-understanding/concurrency.ts`)
  - formats outputs into `[Image]`/`[Audio]`/`[Video]` sections in `ctx.Body` (`src/media-understanding/format.ts`)
- Model/provider selection:
  - Entries come from `tools.media.<capability>.models` plus shared `tools.media.models` (shared CLI entries are ignored unless capabilities are known).
  - If no entries are configured and `tools.media.<capability>.enabled === true`, the runner can auto-select certain providers based on available API keys and built-in default models (e.g. OpenAI audio uses `gpt-4o-mini-transcribe`). (`src/media-understanding/resolve.ts`, `src/media-understanding/runner.ts`, `src/media-understanding/defaults.ts`)
  - For audio providers, request config composes as:
    - `baseUrl`: entry -> capability config -> provider config
    - `headers`: provider config -> capability config -> entry (`src/media-understanding/runner.ts`)
  - Deepgram query options are normalized to snake_case (`detectLanguage` -> `detect_language`, `smartFormat` -> `smart_format`), and `tools.media.audio.deepgram.*` can backfill missing query keys. (`src/media-understanding/runner.ts`)
- Audio transcription is special:
  - It sets `ctx.Transcript`, and rewrites `ctx.CommandBody`/`ctx.RawBody` so downstream command parsing uses either the original user text (if present) or the transcript. (`src/media-understanding/apply.ts`)
- File extraction:
  - Independently of image/audio/video understanding, it may extract text from attached files and append `<file name="..." mime="...">...</file>` blocks.
  - These blocks are XML-escaped to avoid injection via tag breaks. (`src/media-understanding/apply.ts`, `src/media/input-files.ts`)
  - PDF extraction uses `pdfjs-dist`; image rendering from PDFs requires optional `@napi-rs/canvas` and is only used when extracted text is too small. (`src/media/input-files.ts`)
- Image understanding can be skipped when the primary active model supports vision natively. (`src/media-understanding/runner.ts`)
- Provider HTTP calls inside media understanding are SSRF-guarded; explicitly configured provider `baseUrl` enables private-network access for that request (intended for self-hosted endpoints). (`src/media-understanding/providers/shared.ts`)
