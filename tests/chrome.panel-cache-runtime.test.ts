import { describe, expect, it, vi } from "vitest";
import { createPanelCacheRuntime } from "../apps/chrome-extension/src/entrypoints/background/panel-cache-runtime.js";
import type { PanelCachePayload } from "../apps/chrome-extension/src/lib/panel-contracts.js";

const url = "https://example.com/article";

function cache(overrides: Partial<PanelCachePayload> = {}): PanelCachePayload {
  return {
    tabId: 7,
    url,
    title: "Article",
    runId: "run-1",
    slidesRunId: null,
    summaryMarkdown: "Summary",
    summaryFromCache: true,
    slidesSummaryMarkdown: null,
    slidesSummaryComplete: null,
    slidesSummaryModel: null,
    lastMeta: { inputSummary: null, model: null, modelLabel: null },
    slides: null,
    transcriptTimedText: null,
    ...overrides,
  };
}

function createHarness({
  cached = cache(),
  activeTab = { id: 7, url, title: "Article" } as chrome.tabs.Tab,
}: {
  cached?: PanelCachePayload | null;
  activeTab?: chrome.tabs.Tab | null;
} = {}) {
  const panelSessionStore = {
    storePanelCache: vi.fn(),
    getPanelCacheAsync: vi.fn(async () => cached),
  };
  const getActiveTab = vi.fn(async () => activeTab);
  const send = vi.fn();
  const startBrowserSlides = vi.fn();
  const runtime = createPanelCacheRuntime({
    panelSessionStore,
    getActiveTab,
    urlsMatch: (left, right) => left.replace(/\/$/, "") === right.replace(/\/$/, ""),
    send,
    startBrowserSlides,
  });
  const session = {
    windowId: 3,
    inflightUrl: null,
    activeSummaryRun: null,
  };
  return {
    runtime,
    session,
    panelSessionStore,
    getActiveTab,
    send,
    startBrowserSlides,
  };
}

describe("chrome panel cache runtime", () => {
  it("stores valid panel cache payloads", () => {
    const harness = createHarness();
    const payload = cache();

    harness.runtime.store({ type: "panel:cache", cache: payload });

    expect(harness.panelSessionStore.storePanelCache).toHaveBeenCalledWith(payload);
  });

  it("returns the current tab cache", async () => {
    const harness = createHarness();

    await harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-1",
      tabId: 7,
      url,
    });

    expect(harness.send).toHaveBeenCalledWith(harness.session, {
      type: "ui:cache",
      requestId: "cache-1",
      ok: true,
      cache: cache(),
    });
  });

  it("suppresses a cache response when the run generation changes during hydration", async () => {
    let resolveCache!: (value: PanelCachePayload | null) => void;
    const harness = createHarness();
    harness.panelSessionStore.getPanelCacheAsync.mockImplementationOnce(
      async () =>
        await new Promise<PanelCachePayload | null>((resolve) => {
          resolveCache = resolve;
        }),
    );

    const pending = harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-2",
      tabId: 7,
      url,
    });
    harness.session.inflightUrl = "https://example.com/other";
    resolveCache(cache());
    await pending;

    expect(harness.getActiveTab).not.toHaveBeenCalled();
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("suppresses stale cache from another active tab", async () => {
    const harness = createHarness({
      activeTab: { id: 8, url: "https://example.com/other" } as chrome.tabs.Tab,
    });

    await harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-3",
      tabId: 7,
      url,
    });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("suppresses cache from a different active run", async () => {
    const harness = createHarness({ cached: cache({ runId: "run-old" }) });
    harness.session.activeSummaryRun = { run: { id: "run-new", url } };

    await harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-4",
      tabId: 7,
      url,
    });

    expect(harness.send).not.toHaveBeenCalled();
  });

  it("restores browser slides for cached YouTube summaries without slides", async () => {
    const youtubeUrl = "https://www.youtube.com/watch?v=KnUFH5GX_fI";
    const harness = createHarness({
      cached: cache({ url: youtubeUrl }),
      activeTab: { id: 7, url: youtubeUrl } as chrome.tabs.Tab,
    });

    await harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-5",
      tabId: 7,
      url: youtubeUrl,
    });

    expect(harness.startBrowserSlides).toHaveBeenCalledWith(harness.session, {
      inputMode: "video",
      reason: "cache-restore",
    });
  });

  it("requires exact fragment identity for an active run", async () => {
    const fragmentUrl = `${url}#section`;
    const harness = createHarness({
      cached: cache({ url: fragmentUrl, runId: "run-old" }),
      activeTab: { id: 7, url: fragmentUrl } as chrome.tabs.Tab,
    });
    harness.session.activeSummaryRun = { run: { id: "run-new", url } };

    await harness.runtime.get(harness.session, {
      type: "panel:get-cache",
      requestId: "cache-6",
      tabId: 7,
      url: fragmentUrl,
    });

    expect(harness.send).toHaveBeenCalled();
  });
});
