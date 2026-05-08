import { describe, expect, it } from "vitest";
import {
  buildSummaryTimestampLimitInstruction,
  ensureSummaryKeyMoments,
  resolveSummaryTimestampUpperBound,
  sanitizeSummaryKeyMoments,
} from "../src/run/flows/url/summary-timestamps.js";

describe("url summary timestamp sanitization", () => {
  it("uses the known media duration when transcript timestamps stop earlier", () => {
    expect(
      resolveSummaryTimestampUpperBound({
        transcriptSegments: [{ startMs: 1_000, endMs: 10_000, text: "hello" }],
        transcriptTimedText: "[19:32] final line",
        mediaDurationSeconds: 1173,
      }),
    ).toBe(1173);
  });

  it("caps transcript timestamps at the known media duration", () => {
    expect(
      resolveSummaryTimestampUpperBound({
        transcriptSegments: null,
        transcriptTimedText: "[19:35] impossible tail",
        mediaDurationSeconds: 1173,
      }),
    ).toBe(1173);
  });

  it("adds a prompt hint for the final allowed timestamp", () => {
    expect(
      buildSummaryTimestampLimitInstruction({
        transcriptSegments: null,
        transcriptTimedText: "[19:32] final line",
        mediaDurationSeconds: 1173,
      }),
    ).toContain("19:33");
  });

  it("drops only out-of-range key moment lines", () => {
    const summary = [
      "Intro paragraph.",
      "",
      "Key moments",
      "[00:00] Setup",
      "- [12:54] Midpoint",
      "- [19:35] Slight transcript tail overshoot",
      "33:10 Impossible ending",
      "",
      "Closing line with 19:33 still mentioned outside the section.",
    ].join("\n");

    expect(
      sanitizeSummaryKeyMoments({
        markdown: summary,
        maxSeconds: 1173,
      }),
    ).toBe(
      [
        "Intro paragraph.",
        "",
        "Key moments",
        "[00:00] Setup",
        "- [12:54] Midpoint",
        "- [19:33] Slight transcript tail overshoot",
        "",
        "Closing line with 19:33 still mentioned outside the section.",
      ].join("\n"),
    );
  });

  it("removes the entire key moments section when every timestamp is impossible", () => {
    const summary = [
      "Summary first.",
      "",
      "### Key moments",
      "[27:55] Not possible",
      "[33:10] Also not possible",
      "",
      "### Aftermath",
      "Real closing section.",
    ].join("\n");

    expect(
      sanitizeSummaryKeyMoments({
        markdown: summary,
        maxSeconds: 1173,
      }),
    ).toBe(["Summary first.", "", "### Aftermath", "Real closing section."].join("\n"));
  });

  it("adds fallback key moments from timed transcript when the model omits them", () => {
    expect(
      ensureSummaryKeyMoments({
        markdown: "Summary first.",
        extracted: {
          transcriptTimedText: [
            "[0:01] Opening context",
            "[9:46] Middle explanation",
            "[19:35] Beyond the media duration",
          ].join("\n"),
        },
        maxSeconds: 1173,
      }),
    ).toBe(
      [
        "Summary first.",
        "",
        "### Key moments",
        "- [0:01] Opening context",
        "- [9:46] Middle explanation",
      ].join("\n"),
    );
  });
});
