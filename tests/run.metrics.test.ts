import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunMetrics } from "../src/run/run-metrics.js";

describe("run metrics cost estimation", () => {
  it("keeps the total unknown when any billable call lacks usage and an explicit cost", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push(
        {
          provider: "cli",
          model: "cli/codex",
          usage: null,
          costUsd: 0.25,
          purpose: "summary",
        },
        {
          provider: "openai",
          model: "openai/gpt-5.5",
          usage: null,
          purpose: "speaker-identification",
        },
      );

      await expect(metrics.estimateCostUsd()).resolves.toBeNull();
      metrics.llmCalls.pop();
      await expect(metrics.estimateCostUsd()).resolves.toBe(0.25);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps local Ollama calls at zero when usage is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push({
        provider: "ollama",
        model: "ollama/llama3.2",
        usage: null,
        purpose: "summary",
      });
      metrics.setTranscriptionCost(0.4, "$0.40 tx");

      await expect(metrics.estimateCostUsd()).resolves.toBe(0.4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps OpenRouter free-model calls at zero when usage is unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    try {
      const metrics = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      metrics.llmCalls.push({
        provider: "openai",
        model: "openai/xiaomi/mimo-v2-flash:free",
        usage: null,
        purpose: "summary",
      });
      metrics.setTranscriptionCost(0.4, "$0.40 tx");

      await expect(metrics.estimateCostUsd()).resolves.toBe(0.4);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("keeps the total unknown when a free call accompanies an unpriced paid call", async () => {
    const home = mkdtempSync(join(tmpdir(), "summarize-run-metrics-"));
    const addCalls = (metrics: ReturnType<typeof createRunMetrics>) => {
      metrics.llmCalls.push(
        {
          provider: "ollama",
          model: "ollama/llama3.2",
          usage: null,
          purpose: "summary",
        },
        {
          provider: "openai",
          model: "openai/model-not-in-catalog",
          usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
          purpose: "speaker-identification",
        },
      );
      metrics.setTranscriptionCost(0.4, "$0.40 tx");
    };
    try {
      const withoutCatalog = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      addCalls(withoutCatalog);
      await expect(withoutCatalog.estimateCostUsd()).resolves.toBeNull();

      const cacheDir = join(home, ".summarize", "cache");
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(join(cacheDir, "litellm-model_prices_and_context_window.json"), "{}");
      const missingFromCatalog = createRunMetrics({
        env: { HOME: home },
        fetchImpl: vi.fn() as unknown as typeof fetch,
        maxOutputTokensArg: null,
      });
      addCalls(missingFromCatalog);
      await expect(missingFromCatalog.estimateCostUsd()).resolves.toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
