import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { ExtractedLinkContent } from "../src/content/index.js";
import type { ExecFileFn } from "../src/markitdown.js";
import type { UrlFlowContext } from "../src/run/flows/url/types.js";
import { createEmptyRunOverrides } from "../src/run/run-settings.js";

const mocks = vi.hoisted(() => ({
  executeUrlFlow: vi.fn(),
}));

vi.mock("../src/run/flows/url/flow.js", () => ({
  executeUrlFlow: mocks.executeUrlFlow,
}));

import { executeSummarize } from "../src/application/execute-summarize.js";

const extracted: ExtractedLinkContent = {
  url: "https://example.com/video",
  title: "Video",
  description: null,
  siteName: "Example",
  content: "placeholder",
  truncated: false,
  totalCharacters: 11,
  wordCount: 1,
  transcriptCharacters: null,
  transcriptLines: null,
  transcriptWordCount: null,
  transcriptSource: null,
  transcriptionProvider: null,
  transcriptMetadata: null,
  transcriptSegments: null,
  transcriptTimedText: null,
  mediaDurationSeconds: null,
  video: { kind: "direct", url: "https://cdn.example.com/video.mp4" },
  isVideoOnly: true,
  diagnostics: {
    strategy: "html",
    firecrawl: { attempted: false, used: false, cacheMode: "bypass", cacheStatus: "unknown" },
    markdown: { requested: false, used: false, provider: null },
    transcript: {
      cacheMode: "bypass",
      cacheStatus: "unknown",
      textProvided: false,
      provider: null,
      attemptedProviders: [],
    },
  },
};

describe("executeSummarize", () => {
  it("returns delegated asset summaries and emits non-streamed output semantically", async () => {
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      ctx.hooks.onModelChosen?.("google/gemini-2.5-pro");
      ctx.hooks.onSummaryCached?.(false);
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Video summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: "https://cdn.example.com/video.mp4",
            mediaType: "video/mp4",
            filename: "video.mp4",
          },
          footerParts: [],
          llm: {
            provider: "google",
            model: "google/gemini-2.5-pro",
            maxCompletionTokens: null,
            strategy: "single",
          },
        },
      };
    });

    const events: Array<{ type: string; text?: string }> = [];
    const result = await executeSummarize(
      {
        input: {
          kind: "url",
          url: extracted.url,
          title: extracted.title,
          maxCharacters: null,
        },
        modelOverride: "google/gemini-2.5-pro",
        promptOverride: null,
        lengthRaw: "long",
        languageRaw: "auto",
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "run-1",
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      (event) => {
        events.push({
          type: event.type,
          ...(event.type === "summary-delta" ? { text: event.text } : {}),
        });
      },
    );

    expect(result).toMatchObject({
      kind: "summary",
      summary: "Video summary.",
      usedModel: "google/gemini-2.5-pro",
      summaryFromCache: false,
    });
    expect(events.map((event) => event.type)).toEqual([
      "run-started",
      "extraction-started",
      "content-extracted",
      "summary-started",
      "model-selected",
      "summary-cache",
      "summary-delta",
      "run-completed",
    ]);
    expect(events).toContainEqual({ type: "summary-delta", text: "Video summary.\n" });
  });

  it("executes with prepared resources while retaining adapter event hooks", async () => {
    mocks.executeUrlFlow.mockImplementationOnce(async ({ ctx }) => {
      ctx.hooks.onExtracted?.(extracted);
      ctx.hooks.onModelChosen?.("google/gemini-2.5-pro");
      return {
        kind: "delegated-summary",
        extracted,
        slides: null,
        summary: {
          kind: "summary",
          outcome: "model",
          summary: "Prepared summary.",
          summaryEmitted: false,
          summaryFromCache: false,
          prompt: "Prompt",
          extracted: {
            kind: "asset",
            source: "https://cdn.example.com/video.mp4",
            mediaType: "video/mp4",
            filename: "video.mp4",
          },
          footerParts: [],
          llm: {
            provider: "google",
            model: "google/gemini-2.5-pro",
            maxCompletionTokens: null,
            strategy: "single",
          },
        },
      };
    });

    const adapterModel = vi.fn();
    const preparedContext = {
      model: { requestedModelLabel: "prepared/model" },
      hooks: {
        onModelChosen: adapterModel,
        onExtracted: null,
        onSlidesExtracted: null,
        onSlidesProgress: null,
        onSlidesDone: null,
        onSlideChunk: undefined,
        onLinkPreviewProgress: null,
        onSummaryCached: null,
        summarizeAsset: vi.fn(),
        buildReport: vi.fn(async () => ({
          llm: [],
          services: { firecrawl: { requests: 0 }, apify: { requests: 0 } },
        })),
        estimateCostUsd: vi.fn(async () => null),
      },
    } as unknown as UrlFlowContext;
    const eventTypes: string[] = [];

    const result = await executeSummarize(
      {
        input: {
          kind: "url",
          url: extracted.url,
          title: extracted.title,
          maxCharacters: null,
        },
        modelOverride: "google/gemini-2.5-pro",
        promptOverride: null,
        lengthRaw: "long",
        languageRaw: "auto",
        format: "text",
        overrides: createEmptyRunOverrides(),
        extractOnly: false,
        slides: null,
      },
      {
        runId: "run-prepared",
        env: {},
        fetch: globalThis.fetch.bind(globalThis),
        execFile: execFile as unknown as ExecFileFn,
        cache: { mode: "bypass", store: null, ttlMs: 0, maxBytes: 0, path: null },
        mediaCache: null,
      },
      (event) => eventTypes.push(event.type),
      { urlFlowContext: preparedContext },
    );

    expect(result).toMatchObject({
      kind: "summary",
      summary: "Prepared summary.",
      usedModel: "google/gemini-2.5-pro",
    });
    expect(adapterModel).toHaveBeenCalledWith("google/gemini-2.5-pro");
    expect(eventTypes).toContain("model-selected");
    expect(eventTypes.at(-1)).toBe("run-completed");
  });
});
