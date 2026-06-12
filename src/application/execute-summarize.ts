import { isYouTubeUrl } from "../content/index.js";
import type { ExtractedLinkContent } from "../content/index.js";
import { buildUrlPrompt } from "../engine/web-prompt.js";
import { resolveUrlSummaryExecution, type UrlSummaryResolution } from "../engine/web-summary.js";
import { executeUrlFlow } from "../run/flows/url/flow.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import {
  readLastSuccessfulCliProvider,
  writeLastSuccessfulCliProvider,
} from "./cli-fallback-state.js";
import {
  bindSummarizeExecutionEvents,
  type PreparedSummarizeExecution,
} from "./execution-resources.js";
import type {
  ExtractionResult,
  SummarizeEvent,
  SummarizeEventSink,
  SummarizeRequest,
  SummarizeResult,
  SummarizeRuntime,
  SummaryResult,
} from "./summarize-contracts.js";
import { createSummarizeUrlFlowContext } from "./url-runtime.js";

const ignoreEvent: SummarizeEventSink = () => {};

function createVisiblePageContent(
  input: Extract<SummarizeRequest["input"], { kind: "visible-page" }>,
  cacheMode: SummarizeRuntime["cache"]["mode"],
): ExtractedLinkContent {
  let siteName: string | null = null;
  try {
    siteName = new URL(input.url).hostname || null;
  } catch {
    siteName = null;
  }

  return {
    url: input.url,
    title: input.title,
    description: null,
    siteName,
    content: input.text,
    truncated: input.truncated,
    totalCharacters: input.text.length,
    wordCount: input.text.trim() ? input.text.trim().split(/\s+/).length : 0,
    transcriptCharacters: null,
    transcriptLines: null,
    transcriptWordCount: null,
    transcriptSource: null,
    transcriptionProvider: null,
    transcriptMetadata: null,
    transcriptSegments: null,
    transcriptTimedText: null,
    mediaDurationSeconds: null,
    video: null,
    isVideoOnly: false,
    diagnostics: {
      strategy: "html",
      firecrawl: {
        attempted: false,
        used: false,
        cacheMode,
        cacheStatus: "unknown",
      },
      markdown: {
        requested: false,
        used: false,
        provider: null,
      },
      transcript: {
        cacheMode,
        cacheStatus: "unknown",
        textProvided: false,
        provider: null,
        attemptedProviders: [],
      },
    },
  };
}

async function executeVisiblePageSummary({
  ctx,
  input,
  cacheMode,
}: {
  ctx: UrlFlowContext;
  input: Extract<SummarizeRequest["input"], { kind: "visible-page" }>;
  cacheMode: SummarizeRuntime["cache"]["mode"];
}): Promise<{ extracted: ExtractedLinkContent; resolution: UrlSummaryResolution }> {
  const extracted = createVisiblePageContent(input, cacheMode);
  ctx.hooks.onExtracted?.(extracted);

  const prompt = buildUrlPrompt({
    extracted,
    outputLanguage: ctx.flags.outputLanguage,
    lengthArg: ctx.flags.lengthArg,
    promptOverride: ctx.flags.promptOverride ?? null,
    lengthInstruction: ctx.flags.lengthInstruction ?? null,
    languageInstruction: ctx.flags.languageInstruction ?? null,
  });

  const resolution = await resolveUrlSummaryExecution({
    ctx,
    url: input.url,
    extracted,
    prompt,
    onModelChosen: ctx.hooks.onModelChosen ?? null,
    runtime: {
      trace: (name, detail) => ctx.perfTrace?.mark(name, detail),
      onSummaryCached: ctx.hooks.onSummaryCached ?? null,
      readLastSuccessfulCliProvider: () => readLastSuccessfulCliProvider(ctx.io.envForRun),
      rememberCliProvider: (provider) =>
        writeLastSuccessfulCliProvider({ env: ctx.io.envForRun, provider }),
    },
  });
  return { extracted, resolution };
}

function emitResolvedSummary({
  resolution,
  extracted,
  emit,
}: {
  resolution: UrlSummaryResolution;
  extracted: ExtractedLinkContent;
  emit: SummarizeEventSink;
}): string {
  if (resolution.kind === "use-extracted") {
    emit({ type: "summary-delta", text: `${extracted.content}\n` });
    return extracted.content;
  }
  if (!resolution.summaryEmitted) {
    const normalized = resolution.normalizedSummary.replace(/^\n+/, "");
    emit({
      type: "summary-delta",
      text: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
    });
  }
  return resolution.normalizedSummary;
}

function emitNormalizedSummary(summary: string, emit: SummarizeEventSink) {
  const normalized = summary.replace(/^\n+/, "");
  emit({
    type: "summary-delta",
    text: normalized.endsWith("\n") ? normalized : `${normalized}\n`,
  });
}

export async function executeSummarize(
  request: SummarizeRequest,
  runtime: SummarizeRuntime,
  events: SummarizeEventSink = ignoreEvent,
  prepared: PreparedSummarizeExecution | null = null,
): Promise<SummarizeResult> {
  const now = runtime.now ?? Date.now;
  const startedAt = now();
  let usedModel: string | null = null;
  let summaryFromCache = false;
  let summaryText = "";
  let normalizedSummary: string | null = null;
  let extracted: ExtractedLinkContent | null = null;
  let slides: ExtractionResult["slides"] = null;

  const emit = (event: SummarizeEvent) => {
    if (event.type === "model-selected") {
      usedModel = event.modelId;
    } else if (event.type === "summary-cache") {
      summaryFromCache = event.cached;
    } else if (event.type === "content-extracted") {
      extracted = event.content;
    } else if (event.type === "slides-extracted") {
      slides = event.slides;
    } else if (event.type === "summary-delta") {
      summaryText += event.text;
    }
    events(event);
    if (event.type === "content-extracted" && !request.extractOnly) {
      events({ type: "summary-started" });
    }
  };

  emit({ type: "run-started", runId: runtime.runId, input: request.input });

  try {
    if (request.extractOnly && request.input.kind !== "url") {
      throw new Error("Extract-only execution requires a URL input");
    }

    const ctx = prepared
      ? bindSummarizeExecutionEvents(prepared, emit).urlFlowContext
      : createSummarizeUrlFlowContext({
          request,
          runtime,
          runStartedAtMs: startedAt,
          emit,
        });

    if (request.input.kind === "visible-page") {
      const visiblePageResult = await executeVisiblePageSummary({
        ctx,
        input: request.input,
        cacheMode: runtime.cache.mode,
      });
      extracted = visiblePageResult.extracted;
      normalizedSummary = emitResolvedSummary({
        resolution: visiblePageResult.resolution,
        extracted,
        emit,
      });
    } else {
      emit({ type: "extraction-started", url: request.input.url });
      const urlResult = await executeUrlFlow({
        ctx,
        url: request.input.url,
        isYoutubeUrl: isYouTubeUrl(request.input.url),
      });
      extracted = urlResult.extracted;
      if (!slides) slides = urlResult.slides;
      if (!request.extractOnly) {
        if (urlResult.kind === "extraction") {
          throw new Error("Internal error: summary execution returned extraction result");
        }
        if (urlResult.kind === "summary") {
          normalizedSummary = emitResolvedSummary({
            resolution: urlResult.resolution,
            extracted,
            emit,
          });
        } else {
          normalizedSummary = urlResult.summary.summary;
          if (!urlResult.summary.summaryEmitted) {
            emitNormalizedSummary(normalizedSummary, emit);
          }
        }
      }
    }

    if (!extracted) {
      throw new Error("Internal error: missing extracted content");
    }

    if (request.extractOnly) {
      const result: ExtractionResult = {
        kind: "extraction",
        input: request.input as Extract<SummarizeRequest["input"], { kind: "url" }>,
        extracted,
        slides,
      };
      emit({ type: "run-completed", result });
      return result;
    }

    const result: SummaryResult = {
      kind: "summary",
      input: request.input,
      summary: normalizedSummary ?? summaryText.replace(/\n$/, ""),
      usedModel: usedModel ?? ctx.model.requestedModelLabel,
      extracted,
      summaryFromCache,
      elapsedMs: now() - startedAt,
      report: await ctx.hooks.buildReport(),
      costUsd: await ctx.hooks.estimateCostUsd(),
    };
    emit({ type: "run-completed", result });
    return result;
  } catch (error) {
    emit({ type: "run-failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
