---
summary: "Refactor roadmap for the biggest remaining orchestration and parsing hotspots."
read_when:
  - "When planning structural cleanup work."
  - "When touching config, slides, transcript providers, or provider/model orchestration."
---

# Refactor Roadmap

Goal: keep the codebase moving toward smaller modules, clearer boundaries, and cheaper tests without abstracting it into a framework.

## Principles

- Prefer extraction over rewrite.
- Keep behavior stable; ship with regression tests.
- Separate policy from execution.
- Separate parsing from I/O.
- Keep entrypoints thin; move branch-heavy logic into pure helpers.
- Stop at the point where the new shape is clearly better; avoid speculative abstractions.

## Work Order

1. Split config loading and normalization in `src/config.ts`.
2. Split slide terminal/output orchestration in `src/run/flows/url/slides-output.ts`.
3. Split X ingestion in `src/run/bird.ts`.
4. Split YouTube caption discovery/download/parsing in `packages/core/src/content/transcript/providers/youtube/captions.ts`.
5. Normalize transcript provider capability checks across podcast/YouTube/generic providers.
6. Make remote transcription fallback ordering declarative.
7. Clean podcast RSS parsing and transcript normalization.
8. Split run orchestration hotspots (`url/flow.ts`, `url/summary.ts`, `summary-engine.ts`, `run-settings.ts`, `markdown.ts`).
9. Clean Chrome extension state/storage hotspots.
10. Normalize model/provider capability and error shaping.
11. Add test/helpers/docs support so future refactors get cheaper.

## Phase 1: High ROI Hotspots

### 1. Config (`src/config.ts`)

Problem:
- file mixes types, file I/O, comment detection, legacy mapping, schema parsing, validation, and normalization
- hard to test specific branches without loading the whole module mentally
- at `1265` LOC it is the biggest single cleanup target

Target shape:
- `src/config.ts`
  - exported types
  - `loadSummarizeConfig`
  - `mergeConfigEnv`
  - `resolveConfigEnv`
- `src/config/read.ts`
  - config path resolution
  - file read
  - JSON/comment handling
- `src/config/parse-helpers.ts`
  - `isRecord`
  - shared string/number/object parsers
  - provider base URL parsing
- `src/config/model.ts`
  - `ModelConfig` parsing
  - auto rules / token bands
- `src/config/sections.ts`
  - cache/slides/cli/logging/provider/env/apiKeys section parsers
- `src/config/legacy.ts`
  - `apiKeys` to env mapping

Why first:
- improves the highest branch hotspot
- makes later provider/config work cheaper
- good coverage already exists

Tests:
- keep `tests/config*.test.ts`
- add focused section/helper tests only if extraction reveals uncovered pure helpers

### 2. Slides Output (`src/run/flows/url/slides-output.ts`)

Problem:
- terminal rendering, stream handling, inline-image decisions, slide timeline mutation, and final output formatting live together
- state transitions are hard to reason about

Target shape:
- `slides-output.ts`
  - public construction helpers only
- `slides-output-state.ts`
  - reducer/state transitions
- `slides-output-render.ts`
  - terminal frame/render decisions
- `slides-output-stream.ts`
  - summary stream glue

Goal:
- explicit slide-output state machine
- thinner UI adapter
- easier non-terminal tests

Tests:
- keep existing slide output stream/render tests
- add reducer tests for timeline/image/finalization transitions

### 3. X / Tweet Extraction (`src/run/bird.ts`)

Problem:
- CLI execution, endpoint building, payload parsing, media extraction, and client preference all in one file
- xurl support made the module denser

Target shape:
- `bird.ts`
  - public API only
- `bird/exec.ts`
  - process execution and stderr shaping
- `bird/parse.ts`
  - tweet/article text parsing
- `bird/media.ts`
  - media URL extraction
- `bird/client.ts`
  - client preference / endpoint helpers / install tips

Goal:
- pure payload parsing easy to test
- easier future client additions/removals

Tests:
- keep `tests/bird.test.ts`
- keep CLI/progress tests
- add direct parser fixtures only where split changes structure

### 4. YouTube Captions (`packages/core/.../youtube/captions.ts`)

Problem:
- HTML bootstrap parsing, player payload parsing, caption-track selection, transcript download, XML/JSON parsing, and duration extraction are all coupled
- now the biggest transcript-specific branch swamp

Target shape:
- `captions.ts`
  - public entrypoints
- `captions/bootstrap.ts`
  - HTML / player bootstrap extraction
- `captions/tracks.ts`
  - caption track discovery and selection
- `captions/download.ts`
  - HTTP fetch/download helpers
- `captions/parse.ts`
  - JSON/XML transcript parsing
- `captions/duration.ts`
  - duration extraction

Goal:
- isolate fragile HTML parsing from transcript parsing
- make caption selection policy explicit

Tests:
- keep current caption suite
- rebalance tests toward pure parser/selector modules if helpful

## Phase 2: Transcript/Media Policy Cleanup

### 5. Transcript Provider Capabilities

Files:
- `packages/core/src/content/transcript/providers/generic.ts`
- `packages/core/src/content/transcript/providers/youtube/*`
- `packages/core/src/content/transcript/providers/podcast/*`

Problem:
- repeated questions everywhere:
  - any cloud transcription?
  - local transcription available?
  - yt-dlp fallback allowed?
  - which provider label should be surfaced?

Plan:
- add shared capability object/resolver
- use it across provider entrypoints
- keep result types stable

### 6. Remote Transcription Fallback

Files:
- `packages/core/src/transcription/whisper/core.ts`
- `packages/core/src/transcription/whisper/remote.ts`
- `packages/core/src/transcription/whisper/gemini.ts`
- `packages/core/src/transcription/whisper/assemblyai.ts`

Problem:
- provider ordering still partly encoded in condition trees
- provider metadata has improved but execution policy can be more declarative

Plan:
- describe providers as ordered steps with:
  - availability
  - label
  - model name
  - execute
  - terminal/non-terminal failure policy
- keep fallback notes/provider notes centralized

### 7. Podcast RSS + Transcript Normalization

Files:
- `packages/core/src/content/transcript/providers/podcast/rss.ts`
- `packages/core/src/content/transcript/parse.ts`
- `packages/core/src/content/transcript/timestamps.ts`

Problem:
- RSS parsing still mixes feed-shape quirks with result assembly
- segment normalization logic is spread across multiple helpers

Plan:
- split feed parsers by source pattern
- normalize all transcript segments through one pipeline

## Phase 3: Run / CLI Orchestration

### 8. Run Flow Hotspots

Files:
- `src/run/flows/url/flow.ts`
- `src/run/flows/url/summary.ts`
- `src/run/summary-engine.ts`
- `src/run/run-settings.ts`
- `src/run/markdown.ts`

Problem:
- classification, cache, extraction, summary execution, slides, and terminal policy are still interleaved

Plan:
- separate orchestration context from execution steps
- keep public flags/output stable
- prefer extracting pure transforms first

Good first cuts:
- `run-settings` normalization helpers
- markdown pre-render transforms
- summary finish/cache bookkeeping

## Phase 4: Extension Structure

### 9. Chrome Extension State / Storage Cleanup

Files:
- `apps/chrome-extension/src/lib/extension-logs.ts`
- `apps/chrome-extension/src/entrypoints/sidepanel/stream-controller.ts`
- `apps/chrome-extension/src/entrypoints/sidepanel/slides-hydrator.ts`
- `apps/chrome-extension/src/entrypoints/sidepanel/slides-pending.ts`
- `apps/chrome-extension/src/entrypoints/sidepanel/slide-images.ts`

Problem:
- state transitions and persistence policy still leak across multiple files

Plan:
- separate reducers/state models from adapters
- separate storage truncation/serialization from Chrome storage calls
- unify slide cache/hydration/pending semantics

## Phase 5: Provider / Model Layer

### 10. Capability Registry + Error Shaping

Files:
- `src/model-auto.ts`
- `src/llm/generate-text.ts`
- `src/llm/providers/*`

Problem:
- too much implicit provider knowledge
- error handling still partly provider-specific in shape and wording

Plan:
- add provider capability registry:
  - streaming
  - files/PDF support
  - tools/artifacts support
  - native SDK vs chat-completions path
- normalize provider error shape for fallback/reporting

## Phase 6: Test + Docs Infrastructure

### 11. Shared Test Helpers

Plan:
- centralize env/runtime helpers for:
  - local whisper availability
  - browser/chrome storage scaffolding
  - yt-dlp presence
  - provider env isolation

Goal:
- reduce noisy per-test setup
- make future refactors cheaper

### 12. Architecture Notes

Docs to add/update:
- transcript provider flow
- provider/model resolution
- slide rendering/stream flow

Goal:
- reduce “read code for the map” tax

## Guardrails

- No repo-wide renames.
- No abstraction layer that hides behavior behind generic “manager” classes.
- No large mixed commits; one structural change at a time.
- Each refactor must keep or improve test clarity.
- If a split makes call paths harder to read, back it out.

## Success Criteria

- hotspot files materially smaller
- branch-heavy logic moved into pure helpers
- entrypoints easier to scan
- same behavior, same user-facing output
- tests faster to target and more deterministic
