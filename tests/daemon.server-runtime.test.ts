import { describe, expect, it, vi } from "vitest";
import {
  buildActiveSummarizeKey,
  DaemonRuntime,
  resolveDaemonMaxActiveSummaries,
} from "../src/daemon/server-runtime.js";
import { createSession } from "../src/daemon/server-session.js";
import type { ParsedSummarizeRequest } from "../src/daemon/server-summarize-request.js";

const createRequest = (
  overrides: Partial<ParsedSummarizeRequest> = {},
): ParsedSummarizeRequest => ({
  pageUrl: "https://example.com/article",
  title: "Article",
  textContent: "content",
  truncated: false,
  modelOverride: null,
  lengthRaw: "medium",
  languageRaw: "auto",
  promptOverride: null,
  noCache: false,
  extractOnly: false,
  mode: "url",
  maxCharacters: null,
  format: "text",
  overrides: {},
  slidesSettings: null,
  diagnostics: { includeContent: false },
  hasText: true,
  ...overrides,
});

describe("daemon server runtime", () => {
  it("resolves active summarize limits with defaults and clamping", () => {
    expect(resolveDaemonMaxActiveSummaries({})).toBe(4);
    expect(resolveDaemonMaxActiveSummaries({ SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "wat" })).toBe(
      4,
    );
    expect(resolveDaemonMaxActiveSummaries({ SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "0" })).toBe(1);
    expect(resolveDaemonMaxActiveSummaries({ SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "3.9" })).toBe(
      3,
    );
    expect(resolveDaemonMaxActiveSummaries({ SUMMARIZE_DAEMON_MAX_ACTIVE_SUMMARIES: "99" })).toBe(
      32,
    );
  });

  it("builds stable request keys from execution identity, not diagnostics", () => {
    const request = createRequest();
    expect(buildActiveSummarizeKey(request)).toBe(
      buildActiveSummarizeKey(
        createRequest({
          diagnostics: { includeContent: true },
          hasText: false,
          extractOnly: true,
        }),
      ),
    );
    expect(buildActiveSummarizeKey(request)).not.toBe(
      buildActiveSummarizeKey(createRequest({ textContent: "different" })),
    );
  });

  it("owns summarize admission and idempotent release", () => {
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const release = runtime.reserveSummarizeSlot();
    expect(release).not.toBeNull();
    expect(runtime.reserveSummarizeSlot()).toBeNull();
    release?.();
    release?.();
    expect(runtime.reserveSummarizeSlot()).not.toBeNull();
  });

  it("coalesces live sessions and clears stale registrations", () => {
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const session = createSession(() => "summary-1");
    runtime.sessions.set(session.id, session);
    runtime.registerActiveSummarizeRequest("request", session.id);
    expect(runtime.findActiveSummarizeSession("request")).toBe(session);

    session.done = true;
    expect(runtime.findActiveSummarizeSession("request")).toBeNull();

    runtime.registerActiveSummarizeRequest("missing", "missing-session");
    expect(runtime.findActiveSummarizeSession("missing")).toBeNull();
    const replacement = createSession(() => "summary-2");
    runtime.sessions.set(replacement.id, replacement);
    runtime.registerActiveSummarizeRequest("missing", replacement.id);
    expect(runtime.findActiveSummarizeSession("missing")).toBe(replacement);
  });

  it("clears summarize and refresh identities only for the matching session", () => {
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const first = createSession(() => "first");
    const second = createSession(() => "second");

    runtime.registerActiveSummarizeRequest("request", first.id);
    runtime.clearActiveSummarizeRequest("request", second.id);
    runtime.sessions.set(first.id, first);
    expect(runtime.findActiveSummarizeSession("request")).toBe(first);
    runtime.clearActiveSummarizeRequest("request", first.id);
    expect(runtime.findActiveSummarizeSession("request")).toBeNull();

    runtime.registerRefreshSession(first);
    runtime.finishRefreshSession(second.id);
    expect(runtime.activeRefreshSessionId).toBe(first.id);
    runtime.finishRefreshSession(first.id);
    expect(runtime.activeRefreshSessionId).toBeNull();
  });

  it("releases summarize capacity after rejected tasks settle", async () => {
    const runtime = new DaemonRuntime({ maxActiveSummaries: 1 });
    const release = runtime.reserveSummarizeSlot();
    expect(release).not.toBeNull();
    runtime.trackSummarizeTask(Promise.reject(new Error("failed")), release!);
    await vi.waitFor(() => expect(runtime.reserveSummarizeSlot()).not.toBeNull());
  });
});
