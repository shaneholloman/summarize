import { describe, expect, it, vi } from "vitest";
import {
  bindSummarizeExecutionEvents,
  createSummarizeFlowFlags,
  type SummarizeFlowOptions,
} from "../src/application/execution-resources.js";
import type { ResolvedSummarizeSpec } from "../src/application/run-spec.js";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { AssetSummaryContext } from "../src/run/flows/asset/types.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";

const spec: ResolvedSummarizeSpec = {
  format: "markdown",
  maxExtractCharacters: 12_000,
  timeoutMs: 30_000,
  retries: 2,
  markdownMode: "readability",
  preprocessMode: "auto",
  youtubeMode: "yt-dlp",
  firecrawlMode: "auto",
  videoMode: "transcript",
  embeddedVideoMode: "prefer",
  transcriptTimestamps: true,
  transcriptDiarization: "openai",
  outputLanguage: { kind: "fixed", code: "fr", label: "French" },
  lengthArg: { kind: "preset", preset: "medium" },
  forceSummary: true,
  promptOverride: "Prompt",
  lengthInstruction: "Length",
  languageInstruction: "Language",
  maxOutputTokensArg: 512,
  allowAutoCliFallback: false,
  model: {
    requestedModelInput: "openai/gpt-5.4",
    requestedModelLabel: "openai/gpt-5.4",
    requestedModel: {
      kind: "fixed",
      provider: "openai",
      modelId: "gpt-5.4",
      userModelId: "openai/gpt-5.4",
    },
    fixedModelSpec: {
      kind: "fixed",
      provider: "openai",
      modelId: "gpt-5.4",
      userModelId: "openai/gpt-5.4",
    },
    isFallbackModel: false,
    isImplicitAutoSelection: false,
    wantsFreeNamedModel: false,
    isNamedModelSelection: true,
    desiredOutputTokens: 512,
  },
  configPath: "/tmp/config.json",
  configModelLabel: "openai/gpt-5.4",
};

const baseFlow: SummarizeFlowOptions = {
  runStartedAtMs: 123,
  streamingEnabled: true,
  extractMode: false,
};

describe("summarize flow flags", () => {
  it("inherits execution policy from the resolved run", () => {
    expect(createSummarizeFlowFlags(spec, baseFlow)).toMatchObject({
      timeoutMs: 30_000,
      maxExtractCharacters: 12_000,
      format: "markdown",
      transcriptTimestamps: true,
      transcriptDiarization: "openai",
      promptOverride: "Prompt",
      streamMode: "on",
      plain: true,
      configPath: "/tmp/config.json",
    });
  });

  it("preserves explicit adapter overrides, including null extraction limits", () => {
    expect(
      createSummarizeFlowFlags(spec, {
        ...baseFlow,
        maxExtractCharacters: null,
        transcriptTimestamps: false,
        summaryCacheBypass: true,
        json: true,
        metricsEnabled: true,
        streamMode: "off",
        plain: false,
        slidesOutput: true,
        throwOnAssetLikeHtmlError: true,
      }),
    ).toMatchObject({
      maxExtractCharacters: null,
      transcriptTimestamps: false,
      summaryCacheBypass: true,
      json: true,
      metricsEnabled: true,
      streamMode: "off",
      plain: false,
      slidesOutput: true,
      throwOnAssetLikeHtmlError: true,
    });
  });
});

describe("prepared summarize event binding", () => {
  it("preserves adapter callbacks while emitting application events", () => {
    const adapterModel = vi.fn();
    const adapterCache = vi.fn();
    const events: string[] = [];
    const prepared = {
      urlFlowContext: {
        hooks: {
          onModelChosen: adapterModel,
          onExtracted: null,
          onSlidesExtracted: null,
          onSlidesProgress: null,
          onSlidesDone: null,
          onSlideChunk: undefined,
          onLinkPreviewProgress: null,
          onSummaryCached: adapterCache,
          summarizeAsset: vi.fn(),
        },
      } as unknown as UrlFlowContext,
      assetSummaryContext: {
        onSummaryCached: adapterCache,
      } as unknown as AssetSummaryContext,
    };

    const bound = bindSummarizeExecutionEvents(prepared, (event) => {
      events.push(event.type);
    });
    bound.urlFlowContext.hooks.onModelChosen?.("openai/gpt-5.4");
    bound.urlFlowContext.hooks.onExtracted?.({} as ExtractedLinkContent);
    bound.assetSummaryContext?.onSummaryCached?.(true);

    expect(adapterModel).toHaveBeenCalledWith("openai/gpt-5.4");
    expect(adapterCache).toHaveBeenCalledWith(true);
    expect(events).toEqual(["model-selected", "content-extracted", "summary-cache"]);
  });
});
