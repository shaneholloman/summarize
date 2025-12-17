# summarize

Personal URL summarization CLI + a small reusable library.

This repo is a **pnpm workspace** with two publishable packages:

- `@steipete/summarize` (CLI): extracts content from a URL and (optionally) calls an LLM to produce a summary.
- `@steipete/summarizer` (library): content extraction + prompt builders (two entry points).

## Features

- **URL → clean text**: fetches HTML, extracts the main article-ish content, normalizes it for prompts.
- **YouTube transcripts** (when the URL is a YouTube link):
  - `youtubei` transcript endpoint (best-effort)
  - caption track parsing (fallback)
  - Apify transcript actor (optional fallback, requires `APIFY_API_TOKEN`)
- **Prompt-only mode**: print the generated prompt and use any model/provider you want.
- **OpenAI mode**: if `OPENAI_API_KEY` is set, calls the Chat Completions API and prints the model output.

## CLI usage

Build once:

```bash
pnpm install
pnpm build
```

Run without building (direct TS via `tsx`):

```bash
pnpm summarize -- "https://example.com" --prompt
```

Summarize a URL:

```bash
node packages/cli/dist/esm/cli.js "https://example.com"
```

Print the prompt only:

```bash
node packages/cli/dist/esm/cli.js "https://example.com" --prompt
```

Change length and model:

```bash
node packages/cli/dist/esm/cli.js "https://example.com" --length xl --model gpt-4o-mini
```

## Required services & API keys

### OpenAI (optional, but required for “actual summarization”)

If `OPENAI_API_KEY` is **not** set, the CLI prints the prompt instead of calling an LLM.

- `OPENAI_API_KEY` (required to call OpenAI)
- `OPENAI_MODEL` (optional, default: `gpt-5.2`)

### Apify (optional YouTube fallback)

Used only as a fallback when YouTube transcript endpoints fail and only if the token is present.

- `APIFY_API_TOKEN` (optional)

## Library API (for other Node programs)

`@steipete/summarizer` exports two entry points:

- `@steipete/summarizer/content`
  - `createLinkPreviewClient({ fetch?, scrapeWithFirecrawl?, apifyApiToken?, transcriptCache? })`
  - The cache is **pluggable** via `TranscriptCache` (`get/set`). In this repo the CLI currently runs without a persistent cache.
- `@steipete/summarizer/prompts`
  - `buildLinkSummaryPrompt(...)`
  - `SUMMARY_LENGTH_TO_TOKENS`

## Dev

```bash
pnpm check     # biome + build + tests
pnpm lint:fix  # apply Biome fixes
```
