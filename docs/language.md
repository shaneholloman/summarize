# Language

Summarize supports forcing the **output language** for summaries.

This affects the language of the generated summary text (not the extraction/transcription step).

Default: `auto` (match the source content language).

## CLI

```bash
summarize --language auto https://example.com
summarize --language de https://example.com
summarize --lang german https://example.com
```

## Config

`~/.summarize/config.json`:

```json
{
  "language": "en"
}
```

## Supported values

Best effort:

- Special: `auto` (match the source content language)
- Shorthand: `en`, `de`, `es`, `fr`, `pt-BR`, …
- Names: `english`, `german`/`deutsch`, `spanish`, …

Unknown strings are passed through to the model (sanitized). Example: `"language": "Swiss German"`.
