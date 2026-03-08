import { expect, test } from "@playwright/test";
import { buildSlidesPayload } from "./helpers/daemon-fixtures";
import {
  assertNoErrors,
  buildUiState,
  closeExtension,
  getBrowserFromProject,
  launchExtension,
  openExtensionPage,
  seedSettings,
  sendBgMessage,
  waitForPanelPort,
} from "./helpers/extension-harness";
import { allowFirefoxExtensionTests } from "./helpers/extension-test-config";
import {
  getPanelSlideDescriptions,
  getPanelSlidesTimeline,
  getPanelSummaryMarkdown,
  waitForApplySlidesHook,
  waitForSettingsHydratedHook,
} from "./helpers/panel-hooks";

test.skip(
  ({ browserName }) => browserName === "firefox" && !allowFirefoxExtensionTests,
  "Firefox extension tests are blocked by Playwright limitations. Set ALLOW_FIREFOX_EXTENSION_TESTS=1 to run.",
);

test("sidepanel resumes slides when returning to a tab", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);

    const slidesPayload = {
      sourceUrl: "https://www.youtube.com/watch?v=abc123",
      sourceId: "alpha",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/alpha/1?v=1",
          ocrText: "Alpha slide one.",
        },
      ],
    };
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, slides: slidesPayload }),
      });
    });

    const slidesStreamBody = [
      "event: slides",
      `data: ${JSON.stringify(slidesPayload)}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: slidesStreamBody,
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: ["event: done", "data: {}", ""].join("\n"),
      });
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=abc123", title: "Alpha Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: "https://www.youtube.com/watch?v=abc123",
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Video");

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Alpha");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel replaces stale slides when rerunning the same video", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: false,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);

    await page.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const url = route.request().url();
      if (url.includes("/slides/events")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: ["event: done", "data: {}", ""].join("\n"),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: chunk",
          `data: ${JSON.stringify({ text: "Summary" })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: false, error: "not found" }),
      });
    });
    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const uiState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=rerun123", title: "Rerun Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: false,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    await sendBgMessage(harness, { type: "ui:state", state: uiState });

    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-1",
        url: "https://www.youtube.com/watch?v=rerun123",
        title: "Rerun Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary");

    await page.evaluate(
      (payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applySlidesPayload?.(payload);
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=rerun123",
        sourceId: "youtube-rerun",
        sourceKind: "youtube",
        ocrAvailable: true,
        slides: [
          {
            index: 1,
            timestamp: 0,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=1",
            ocrText: "First run slide one.",
          },
          {
            index: 2,
            timestamp: 20,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/2?v=1",
            ocrText: "First run slide two.",
          },
          {
            index: 3,
            timestamp: 40,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/3?v=1",
            ocrText: "First run slide three.",
          },
        ],
      },
    );
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(3);

    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-2",
        url: "https://www.youtube.com/watch?v=rerun123",
        title: "Rerun Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary");

    await page.evaluate(
      (payload) => {
        const hooks = (
          window as typeof globalThis & {
            __summarizeTestHooks?: { applySlidesPayload?: (value: unknown) => void };
          }
        ).__summarizeTestHooks;
        hooks?.applySlidesPayload?.(payload);
      },
      {
        sourceUrl: "https://www.youtube.com/watch?v=rerun123",
        sourceId: "youtube-rerun",
        sourceKind: "youtube",
        ocrAvailable: true,
        slides: [
          {
            index: 1,
            timestamp: 5,
            imageUrl: "http://127.0.0.1:8787/v1/slides/youtube-rerun/1?v=2",
            ocrText: "Second run only slide.",
          },
        ],
      },
    );

    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides[0]?.[1] ?? "").toContain("Second run only slide");
    expect(slides.some(([, text]) => text.includes("First run slide two"))).toBe(false);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel starts pending slides after returning to a tab with seeded placeholders", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);
    await waitForApplySlidesHook(page);

    const targetUrl = "https://www.youtube.com/watch?v=abc123";
    const slidesPayload = buildSlidesPayload({
      sourceUrl: targetUrl,
      sourceId: "youtube-abc123",
      count: 1,
      textPrefix: "Alpha",
    });

    const summaryBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );

    await page.route("http://127.0.0.1:8787/v1/summarize/summary-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: summaryBody("Summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: summaryBody("Slides summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/**/slides", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: true, slides: slidesPayload }),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: slides",
          `data: ${JSON.stringify(slidesPayload)}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: targetUrl, title: "Alpha Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      stats: { pageWords: 120, videoDurationSeconds: 120 },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Bravo Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "summary-a",
        url: targetUrl,
        title: "Alpha Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect
      .poll(async () => (await getPanelSlidesTimeline(page)).length, { timeout: 10_000 })
      .toBeGreaterThan(1);

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    const waitForSlidesEvents = page.waitForResponse(
      (response) =>
        response.url().includes("/v1/summarize/slides-a/slides/events") &&
        response.status() === 200,
      { timeout: 10_000 },
    );
    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: targetUrl,
    });
    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect(page.locator("#title")).toHaveText("Alpha Video");
    await waitForSlidesEvents;

    await expect.poll(async () => (await getPanelSlidesTimeline(page)).length).toBe(1);
    const slides = await getPanelSlideDescriptions(page);
    expect(slides.some(([, text]) => text.includes("Alpha"))).toBe(true);

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel reconnects cached slide runs after tab restore", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
      slidesOcrEnabled: true,
    });
    const page = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(page);
    await waitForSettingsHydratedHook(page);

    const sseBody = (text: string) =>
      ["event: chunk", `data: ${JSON.stringify({ text })}`, "", "event: done", "data: {}", ""].join(
        "\n",
      );
    await page.route("http://127.0.0.1:8787/v1/summarize/run-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody("Summary A"),
      });
    });
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/events", async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: sseBody("Slides summary A"),
      });
    });

    const slidesPayload = {
      sourceUrl: "https://www.youtube.com/watch?v=cache123",
      sourceId: "cache-run",
      sourceKind: "youtube",
      ocrAvailable: true,
      slides: [
        {
          index: 1,
          timestamp: 0,
          imageUrl: "http://127.0.0.1:8787/v1/slides/cache-run/1?v=1",
          ocrText: "Cached slide one.",
        },
      ],
    };
    const slidesStreamBody = [
      "event: slides",
      `data: ${JSON.stringify(slidesPayload)}`,
      "",
      "event: done",
      "data: {}",
      "",
    ].join("\n");
    let slidesEventsRequests = 0;
    await page.route("http://127.0.0.1:8787/v1/summarize/slides-a/slides/events", async (route) => {
      slidesEventsRequests += 1;
      if (slidesEventsRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      try {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: slidesStreamBody,
        });
      } catch {
        // First request is intentionally abandoned when the tab changes.
      }
    });

    const placeholderPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3kq0cAAAAASUVORK5CYII=",
      "base64",
    );
    await page.route("http://127.0.0.1:8787/v1/slides/**", async (route) => {
      await route.fulfill({
        status: 200,
        headers: {
          "content-type": "image/png",
          "x-summarize-slide-ready": "1",
        },
        body: placeholderPng,
      });
    });

    const tabAState = buildUiState({
      tab: { id: 1, url: "https://www.youtube.com/watch?v=cache123", title: "Cached Video" },
      media: { hasVideo: true, hasAudio: true, hasCaptions: true },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });
    const tabBState = buildUiState({
      tab: { id: 2, url: "https://example.com", title: "Other Tab" },
      media: { hasVideo: false, hasAudio: false, hasCaptions: false },
      settings: {
        autoSummarize: false,
        slidesEnabled: true,
        slidesParallel: true,
        slidesOcrEnabled: true,
        tokenPresent: true,
      },
    });

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "run-a",
        url: "https://www.youtube.com/watch?v=cache123",
        title: "Cached Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(page.locator("#render")).toContainText("Summary A");

    await sendBgMessage(harness, {
      type: "slides:run",
      ok: true,
      runId: "slides-a",
      url: "https://www.youtube.com/watch?v=cache123",
    });
    await expect.poll(async () => slidesEventsRequests).toBe(1);

    await sendBgMessage(harness, { type: "ui:state", state: tabBState });
    await expect(page.locator("#title")).toHaveText("Other Tab");
    await expect.poll(async () => (await getPanelSlideDescriptions(page)).length).toBe(0);

    await sendBgMessage(harness, { type: "ui:state", state: tabAState });
    await expect.poll(async () => slidesEventsRequests).toBeGreaterThan(1);
    await expect.poll(async () => await getPanelSummaryMarkdown(page)).toContain("Summary A");

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});

test("sidepanel retry requests a fresh run when parallel slides have no run id", async ({
  browserName: _browserName,
}, testInfo) => {
  const harness = await launchExtension(getBrowserFromProject(testInfo.project.name));

  try {
    await seedSettings(harness, {
      token: "test-token",
      autoSummarize: false,
      slidesEnabled: true,
      slidesParallel: true,
    });
    const url = "https://www.youtube.com/watch?v=retry12345";
    const panel = await openExtensionPage(harness, "sidepanel.html", "#title");
    await waitForPanelPort(panel);
    await waitForSettingsHydratedHook(panel);

    await panel.route("http://127.0.0.1:8787/v1/summarize/**/events", async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.includes("/slides/events")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: ["event: done", "data: {}", ""].join("\n"),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream" },
        body: [
          "event: chunk",
          `data: ${JSON.stringify({ text: "Video summary" })}`,
          "",
          "event: done",
          "data: {}",
          "",
        ].join("\n"),
      });
    });

    await sendBgMessage(harness, {
      type: "ui:state",
      state: buildUiState({
        tab: { id: 1, url, title: "Retry Video" },
        media: { hasVideo: true, hasAudio: true, hasCaptions: true },
        settings: {
          autoSummarize: false,
          slidesEnabled: true,
          slidesParallel: true,
          tokenPresent: true,
        },
      }),
    });
    await sendBgMessage(harness, {
      type: "run:start",
      run: {
        id: "summary-run",
        url,
        title: "Retry Video",
        model: "auto",
        reason: "manual",
      },
    });
    await expect(panel.locator("#render")).toContainText("Video summary");

    await sendBgMessage(harness, {
      type: "slides:run",
      ok: false,
      error: "Slides request failed",
    });
    await expect(panel.locator("#slideNotice")).toContainText("Slides request failed");
    await expect(panel.locator("#slideNoticeRetry")).toBeVisible();
    await panel.evaluate(() => {
      const port = (
        window as typeof globalThis & {
          __summarizePanelPort?: { postMessage: (payload: object) => void };
          __capturedPanelMessages?: object[];
        }
      ).__summarizePanelPort;
      if (!port) throw new Error("Missing panel port");
      const captured: object[] = [];
      (
        window as typeof globalThis & { __capturedPanelMessages?: object[] }
      ).__capturedPanelMessages = captured;
      port.postMessage = (payload: object) => {
        captured.push(payload);
      };
    });
    await panel.locator("#slideNoticeRetry").click();
    await expect
      .poll(async () => {
        return await panel.evaluate(() => {
          return (
            (
              window as typeof globalThis & {
                __capturedPanelMessages?: Array<{ type?: string; refresh?: boolean }>;
              }
            ).__capturedPanelMessages ?? []
          ).map((message) => ({
            type: message.type ?? null,
            refresh: message.refresh ?? null,
          }));
        });
      })
      .toContainEqual({ type: "panel:summarize", refresh: true });

    assertNoErrors(harness);
  } finally {
    await closeExtension(harness.context, harness.userDataDir);
  }
});
