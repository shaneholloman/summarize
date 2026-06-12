import { Writable } from "node:stream";
import type { SummarizeConfig } from "../config.js";
import type { SummaryStreamHandler } from "../engine/events.js";
import { executeAssetSummary } from "../run/flows/asset/summary.js";
import type { UrlFlowContext } from "../run/flows/url/types.js";
import {
  buildPromptLengthInstruction,
  createEmptyRunOverrides,
  type RunOverrides,
  resolveOutputLanguageSetting,
  resolveSummaryLength,
} from "../run/run-settings.js";
import { scopeTranscriptCacheForDiarization } from "../shared/transcript-diarization-cache-scope.js";
import { createRunConfigInput } from "./config-state.js";
import { resolveRunContextState } from "./context.js";
import { createRunFlowContexts } from "./flow-contexts.js";
import {
  createExecutableRunModel,
  createRunModelRuntime,
  resolveRunModelSpec,
} from "./model-runtime.js";
import type {
  SummarizeEventSink,
  SummarizeRequest,
  SummarizeRuntime,
} from "./summarize-contracts.js";

export function createEventSummaryStreamHandler(emit: SummarizeEventSink): SummaryStreamHandler {
  return {
    onChunk: ({ streamed, prevStreamed }) => {
      const normalizedStreamed = streamed.replace(/^\n+/, "");
      const normalizedPrevious = prevStreamed.replace(/^\n+/, "");
      const chunk = normalizedStreamed.startsWith(normalizedPrevious)
        ? normalizedStreamed.slice(normalizedPrevious.length)
        : normalizedStreamed;
      if (!chunk) return false;
      emit({ type: "summary-delta", text: chunk });
      return true;
    },
    onDone: (finalText) => {
      if (finalText.endsWith("\n")) return false;
      emit({ type: "summary-delta", text: "\n" });
      return true;
    },
    onReset: () => {},
  };
}

export function createEventWritable(
  emit: SummarizeEventSink,
  enabled = true,
): NodeJS.WritableStream {
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      const text =
        typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "";
      if (enabled && text) emit({ type: "summary-delta", text });
      callback();
    },
  });
  (stream as unknown as { isTTY?: boolean }).isTTY = false;
  return stream;
}

function applyAutoCliFallbackOverrides(
  config: SummarizeConfig | null,
  overrides: RunOverrides,
): SummarizeConfig | null {
  const hasOverride = overrides.autoCliFallbackEnabled !== null || overrides.autoCliOrder !== null;
  if (!hasOverride) return config;
  const current = config ?? {};
  const currentCli = current.cli ?? {};
  const currentAutoFallback = currentCli.autoFallback ?? currentCli.magicAuto ?? {};
  return {
    ...current,
    cli: {
      ...currentCli,
      autoFallback: {
        ...currentAutoFallback,
        ...(typeof overrides.autoCliFallbackEnabled === "boolean"
          ? { enabled: overrides.autoCliFallbackEnabled }
          : {}),
        ...(Array.isArray(overrides.autoCliOrder) ? { order: overrides.autoCliOrder } : {}),
      },
    },
  };
}

export function createSummarizeUrlFlowContext(args: {
  request: SummarizeRequest;
  runtime: SummarizeRuntime;
  runStartedAtMs: number;
  emit: SummarizeEventSink;
}): UrlFlowContext {
  const { request, runtime, runStartedAtMs, emit } = args;
  const {
    modelOverride,
    promptOverride,
    lengthRaw,
    languageRaw,
    format,
    overrides,
    extractOnly,
    slides,
  } = request;
  const { env, fetch: fetchImpl, urlFetch: urlFetchImpl, cache, mediaCache, execFile } = runtime;
  const maxExtractCharacters = request.input.kind === "url" ? request.input.maxCharacters : null;

  const envForRun: Record<string, string | undefined> = { ...env };

  const languageExplicitlySet = typeof languageRaw === "string" && Boolean(languageRaw.trim());

  const resolvedOverrides: RunOverrides = overrides ?? createEmptyRunOverrides();
  if (resolvedOverrides.transcriber) {
    envForRun.SUMMARIZE_TRANSCRIBER = resolvedOverrides.transcriber;
  }
  const videoModeOverride = resolvedOverrides.videoMode;
  const embeddedVideoOverride = resolvedOverrides.embeddedVideoMode;
  const resolvedFormat = format === "markdown" ? "markdown" : "text";

  const runContext = resolveRunContextState({
    env: envForRun,
    envForRun,
    configInput: createRunConfigInput({
      languageRaw: typeof languageRaw === "string" ? languageRaw : null,
      languageExplicit: languageExplicitlySet,
      videoModeRaw: videoModeOverride ?? "auto",
      videoModeExplicit: videoModeOverride != null,
      embeddedVideoModeRaw: embeddedVideoOverride ?? "auto",
      embeddedVideoModeExplicit: embeddedVideoOverride != null,
    }),
  });
  const {
    config,
    configPath,
    outputLanguage: outputLanguageFromConfig,
    videoMode,
    embeddedVideoMode,
    configForCli,
    configModelLabel,
  } = runContext;
  const configForCliWithMagic = applyAutoCliFallbackOverrides(configForCli, resolvedOverrides);
  const allowAutoCliFallback = resolvedOverrides.autoCliFallbackEnabled === true;
  const { lengthArg } = resolveSummaryLength(lengthRaw, config?.output?.length ?? "long");
  const maxOutputTokensArg = resolvedOverrides.maxOutputTokensArg;
  const modelSpec = resolveRunModelSpec({
    context: runContext,
    envForRun,
    explicitModelArg: modelOverride?.trim() ? modelOverride.trim() : null,
    configForSelection: configForCliWithMagic,
    lengthArg,
    maxOutputTokensArg,
  });
  const stdout = createEventWritable(emit, !extractOnly);
  const stderr = process.stderr;

  const timeoutMs = resolvedOverrides.timeoutMs ?? 120_000;
  const retries = resolvedOverrides.retries ?? 1;
  const firecrawlMode = resolvedOverrides.firecrawlMode ?? "off";
  const markdownMode =
    resolvedOverrides.markdownMode ?? (resolvedFormat === "markdown" ? "readability" : "off");
  const preprocessMode = resolvedOverrides.preprocessMode ?? "auto";
  const youtubeMode = resolvedOverrides.youtubeMode ?? "auto";

  const modelRuntime = createRunModelRuntime({
    context: runContext,
    env: envForRun,
    envForRun,
    metricsEnv: envForRun,
    fetchImpl,
    execFileImpl: execFile,
    maxOutputTokensArg,
    timeoutMs,
    retries,
    streamingEnabled: true,
  });
  const { metrics } = modelRuntime;
  const summaryStream = createEventSummaryStreamHandler(emit);
  const model = createExecutableRunModel({
    spec: modelSpec,
    runtime: modelRuntime,
    context: runContext,
    allowAutoCliFallback,
    summaryStream,
  });

  const outputLanguage = resolveOutputLanguageSetting({
    raw: languageRaw,
    fallback: outputLanguageFromConfig,
  });

  const lengthInstruction = promptOverride ? buildPromptLengthInstruction(lengthArg) : null;
  const languageInstruction =
    promptOverride && outputLanguage.kind === "fixed"
      ? `Output should be ${outputLanguage.label}.`
      : null;

  const urlCache = scopeTranscriptCacheForDiarization(
    cache,
    resolvedOverrides.transcriptDiarization ?? null,
  );
  const io: UrlFlowContext["io"] = {
    env: envForRun,
    envForRun,
    stdout,
    stderr,
    execFileImpl: execFile,
    fetch: metrics.trackedFetch,
    ...(urlFetchImpl ? { urlFetch: urlFetchImpl } : {}),
  };
  const flags: UrlFlowContext["flags"] = {
    timeoutMs,
    maxExtractCharacters,
    retries,
    format: resolvedFormat,
    markdownMode,
    preprocessMode,
    youtubeMode,
    firecrawlMode,
    videoMode,
    embeddedVideoMode,
    transcriptTimestamps: resolvedOverrides.transcriptTimestamps ?? false,
    transcriptDiarization: resolvedOverrides.transcriptDiarization ?? null,
    speakerIdentification: null,
    outputLanguage,
    lengthArg,
    forceSummary: resolvedOverrides.forceSummary ?? false,
    promptOverride,
    lengthInstruction,
    languageInstruction,
    summaryCacheBypass: false,
    maxOutputTokensArg,
    json: false,
    extractMode: extractOnly ?? false,
    metricsEnabled: false,
    metricsDetailed: false,
    shouldComputeReport: false,
    runStartedAtMs,
    verbose: false,
    verboseColor: false,
    progressEnabled: false,
    streamMode: "on",
    streamingEnabled: true,
    plain: true,
    configPath,
    configModelLabel,
    slides: slides ?? null,
    slidesDebug: false,
    slidesOutput: false,
  };
  const runtimeHooks = {
    setTranscriptionCost: metrics.setTranscriptionCost,
    writeViaFooter: () => {},
    clearProgressForStdout: () => {},
    restoreProgressAfterStdout: undefined,
    setClearProgressBeforeStdout: () => {},
    clearProgressIfCurrent: () => {},
    buildReport: metrics.buildReport,
    estimateCostUsd: metrics.estimateCostUsd,
  };
  const { assetSummaryContext, urlFlowContext } = createRunFlowContexts({
    cacheState: urlCache,
    mediaCache,
    io,
    flags,
    model,
    runtimeHooks,
    eventHooks: {
      onModelChosen: (modelId) => emit({ type: "model-selected", modelId }),
      onExtracted: (content) => emit({ type: "content-extracted", content }),
      onSlidesExtracted: (extractedSlides) =>
        emit({ type: "slides-extracted", slides: extractedSlides }),
      onSlidesProgress: (text) => emit({ type: "slides-progress", text }),
      onSlidesDone: (result) => emit({ type: "slides-completed", ...result }),
      onSlideChunk: ({ slide, meta }) => emit({ type: "slide", slide, meta }),
      onLinkPreviewProgress: (event) => emit({ type: "extraction-progress", event }),
      onSummaryCached: (cached) => emit({ type: "summary-cache", cached }),
    },
    assetSummaryOverrides: { format: "text" },
  });

  return {
    ...urlFlowContext,
    hooks: {
      ...urlFlowContext.hooks,
      summarizeAsset: (args) => executeAssetSummary(assetSummaryContext, args),
    },
  };
}
