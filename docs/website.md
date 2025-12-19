# Website mode

Use this for non-YouTube URLs.

## What it does

- Fetches the page HTML.
- Extracts “article-ish” content and normalizes it into clean text.
- If extraction looks blocked or too thin, it can retry via Firecrawl (Markdown).
- In `--extract-only` mode, the CLI prefers Firecrawl Markdown by default when `FIRECRAWL_API_KEY` is configured.
- In `--extract-only` mode, `--markdown auto|llm` can also convert HTML → Markdown via an LLM using the configured `--model` (no provider fallback).

## Flags

- `--firecrawl off|auto|always`
- `--markdown off|auto|llm` (default: `auto`; only affects `--extract-only` for non-YouTube URLs)
- Raw mode: use `--firecrawl off --markdown off` (there is no `--raw` flag).
- `--timeout 30s|30|2m|5000ms` (default: `2m`)
- `--extract-only` (print extracted content; no summary LLM call)
- `--json` (emit a single JSON object)
- `--verbose` (progress + which extractor was used)
- `--metrics off|on|detailed` (default: `on`; `detailed` prints token usage + estimated costs)

## API keys

- Optional: `FIRECRAWL_API_KEY` (for the Firecrawl fallback / preferred Markdown output)
- Optional: `XAI_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` (also accepts `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_API_KEY`) (required only when `--markdown llm` is used, or when `--markdown auto` falls back to LLM conversion)
