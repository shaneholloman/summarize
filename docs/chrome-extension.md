---
summary: "Chrome side panel extension + daemon architecture, setup, and troubleshooting."
read_when:
  - "When working on the extension, daemon, or side panel UX."
---

# Chrome Side Panel (Chrome Extension + Daemon)

Goal: Chrome **Side Panel** (“real sidebar”) summarizes **what you see** on the current tab. Panel open → navigation → auto summarize (optional) → **streaming** Markdown rendered in-panel.

Quickstart:

- Install summarize (choose one):
  - `npm i -g @steipete/summarize`
  - `brew install steipete/tap/summarize` (macOS arm64)
- Build/load extension: `apps/chrome-extension/README.md`
- Open side panel → copy token install command → run:
  - `summarize daemon install --token <TOKEN>` (macOS: LaunchAgent, Linux: systemd user, Windows: Scheduled Task)
- Verify:
  - `summarize daemon status`
  - Restart (if needed): `summarize daemon restart`

Dev (repo checkout):

- Use: `pnpm summarize daemon install --token <TOKEN> --dev` (autostart service runs `src/cli.ts` via `tsx`, no `dist/` build required).

## Troubleshooting

- “Daemon not reachable”:
  - `summarize daemon status`
  - Logs: `~/.summarize/logs/daemon.err.log`
- Tweet video not transcribing / no progress:
  - Ensure `yt-dlp` is available on your PATH (or set `YT_DLP_PATH`) and you have a transcription provider (`whisper.cpp` installed or `OPENAI_API_KEY` / `FAL_KEY`).
  - Re-run `summarize daemon install --token <TOKEN>` to refresh the daemon env snapshot (launchd won’t inherit your shell PATH).
- “Could not establish connection / Receiving end does not exist”:
  - The content script wasn’t injected (yet), or Chrome blocked site access.
  - Chrome → extension details → “Site access” → “On all sites” (or allow the domain), then reload the tab.

## Architecture

- **Extension (MV3, WXT)**
  - Side Panel UI: length + typography controls (font family + size), auto/manual toggle.
  - Background service worker: tab + navigation tracking, content extraction, starts summarize runs.
  - Content script: extract readable article text from the **rendered DOM** via Readability; also detect SPA URL changes.
  - Panel page streams SSE directly (MV3 service workers can be flaky for long-lived streams).
- **Daemon (local, autostart service)**
  - HTTP server on `127.0.0.1:8787` only.
  - Token-authenticated API.
  - Runs the existing summarize pipeline (env/config-based) and streams tokens to client via SSE.

## Data Flow

1) User opens side panel (click extension icon).
2) Panel sends a “ready” message to the background (plus periodic “ping” heartbeats while open).
3) On nav/tab change (and auto enabled): background asks the content script to extract `{ url, title, text }` (best-effort).
4) Background `POST`s payload to daemon `/v1/summarize` with `Authorization: Bearer <token>`.
5) Panel opens `/v1/summarize/<id>/events` (SSE) and renders streamed Markdown.

## Auto Mode (URL + Page Text)

The extension always sends the same request shape:

- Always: `url`, `title`
- When available: extracted `text` + `truncated`
- `mode: "auto"`

The daemon decides the best pipeline:

- YouTube / video / podcast / direct media URLs → prefer **URL** pipeline (transcripts, yt-dlp, Whisper, readability, …).
- Normal articles with extracted text → prefer **page** pipeline (“what you see”).
- Fallback: if the preferred path fails before output starts, try the other input (when available).

## SPA Navigation

- Background listens to `chrome.webNavigation.onHistoryStateUpdated` (SPA route changes) and `tabs.onUpdated` (page loads).
- Only triggers summarize when the side panel is open (and auto is enabled).

## Markdown Rendering

- Use `markdown-it` in the panel.
- Disable raw HTML: `html: false` (avoid sanitizing libraries).
- `linkify: true`.
- Render links with `target=_blank` + `rel=noopener noreferrer`.

## Model Selection UX

- Settings:
  - Model preset (Options → Advanced): `auto` | `free` | custom string (e.g. `openai/gpt-5-mini`, `openrouter/...`).
  - Length: `short|medium|long|xl|xxl` (or a character target like `20k`).
  - Language: `auto` (match source) or a tag like `en`, `de`, `pt-BR` (or free-form like “German”).
  - Prompt override (advanced): custom instruction prefix (context + content still appended).
  - Auto summarize: on/off.
  - Typography: font family (dropdown + custom), font size (slider).
- Extension includes current settings in request; daemon treats them like CLI flags (`--model`, `--length`, `--language`, `--prompt`).

## Token Pairing / Setup Mode

Problem: daemon must be secured; extension must discover and pair with it.

- Side panel “Setup” state:
  - Generates token (random, 32+ bytes).
  - Shows:
    - `summarize daemon install --token <TOKEN>` (macOS: LaunchAgent, Linux: systemd user, Windows: Scheduled Task)
    - `summarize daemon status`
  - “Copy command” button.
- Daemon stores token in `~/.summarize/daemon.json`.
- Extension stores token in `chrome.storage.local`.
- If daemon unreachable or 401: show Setup state + troubleshooting.

## Daemon Endpoints

- `GET /health`
  - 200 JSON: `{ ok: true, pid }`
- `GET /v1/ping`
  - Requires auth; returns `{ ok: true }`
- `POST /v1/summarize`
  - Headers: `Authorization: Bearer <token>`
  - Body:
    - `url: string` (required)
    - `title: string | null`
    - `model?: string` (e.g. `auto`, `free`, `openai/gpt-5-mini`, ...)
    - `length?: string` (e.g. `short`, `xl`, `20k`)
    - `language?: string` (e.g. `auto`, `en`, `de`, `pt-BR`)
    - `prompt?: string` (custom instruction prefix)
    - `mode?: "auto" | "page" | "url"` (default: `"auto"`)
    - `maxCharacters?: number | null` (caps URL-mode extraction before summarization)
    - `text?: string` (required for `mode: "page"`; optional for `auto`)
    - `truncated?: boolean` (optional; indicates extracted `text` was shortened)
  - 200 JSON: `{ ok: true, id }`
- `GET /v1/summarize/:id/events` (SSE)
  - `event: chunk` `data: { text }`
  - `event: meta` `data: { model }`
  - `event: status` `data: { text }` (progress messages before output starts)
  - `event: metrics` `data: { elapsedMs, summary, details, summaryDetailed, detailsDetailed }`
  - `event: done` `data: {}`
  - `event: error` `data: { message }`

Notes:
- SSE keeps the extension simple + streaming-friendly.
- Requests keyed by `id`; daemon keeps a small in-memory map while streaming.

## Daemon Autostart

- CLI commands:
  - `summarize daemon install --token <token> [--port 8787]`
    - Writes `~/.summarize/daemon.json`
    - Installs platform autostart service; verifies `/health`
  - `summarize daemon uninstall`
  - `summarize daemon status`
  - `summarize daemon run` (foreground; used by autostart service)
- Ensure “single daemon”:
  - Stable service name + predictable unit/task path
  - `install` replaces previous install and validates token match

Platform details:

- macOS: LaunchAgent plist in `~/Library/LaunchAgents/<label>.plist`
- Linux: systemd user unit in `~/.config/systemd/user/summarize-daemon.service`
- Windows: Scheduled Task “Summarize Daemon” + `~/.summarize/daemon.cmd`

## Docs

- `docs/chrome-extension.md` (this file): architecture + setup + troubleshooting.
- Main `README.md`: link to extension doc and “Quickstart: 2 commands + load unpacked”.
- `apps/chrome-extension/README.md`: extension-specific dev/build/load-unpacked instructions.

## Status

- Implemented (daemon + CLI + Chrome extension).
