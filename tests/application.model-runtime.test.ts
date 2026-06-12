import { describe, expect, it, vi } from "vitest";
import { createRunConfigInput } from "../src/application/config-state.js";
import { resolveRunContextState } from "../src/application/context.js";
import {
  createExecutableRunModel,
  createRunModelRuntime,
  resolveRunModelSpec,
} from "../src/application/model-runtime.js";

describe("application model runtime", () => {
  it("resolves model intent separately from process resources", () => {
    const env = { OPENAI_API_KEY: "openai-key" };
    const context = resolveRunContextState({
      env,
      envForRun: env,
      configInput: createRunConfigInput(),
    });

    const spec = resolveRunModelSpec({
      context,
      envForRun: env,
      explicitModelArg: "openai/gpt-5.4",
      configForSelection: context.configForCli,
      lengthArg: { kind: "preset", preset: "medium" },
      maxOutputTokensArg: null,
    });
    const runtime = createRunModelRuntime({
      context,
      env,
      envForRun: env,
      metricsEnv: env,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      execFileImpl: vi.fn(),
      maxOutputTokensArg: null,
      timeoutMs: 1_000,
      retries: 1,
      streamingEnabled: false,
    });

    expect(spec.requestedModel).toMatchObject({
      kind: "fixed",
      userModelId: "openai/gpt-5.4",
    });
    expect(spec.fixedModelSpec).toBe(spec.requestedModel);
    expect(spec.desiredOutputTokens).toBeGreaterThan(0);
    expect(runtime.apiStatus.apiKey).toBe("openai-key");
    expect(runtime.summaryEngine.envHasKeyFor("OPENAI_API_KEY")).toBe(true);
    expect(runtime.metrics.llmCalls).toEqual([]);

    const executable = createExecutableRunModel({
      spec,
      runtime,
      context,
      allowAutoCliFallback: true,
      summaryStream: null,
    });
    expect(executable.requestedModel).toBe(spec.requestedModel);
    expect(executable.allowAutoCliFallback).toBe(true);
    expect(executable.apiStatus).toBe(runtime.apiStatus);
    expect(executable.summaryEngine).toBe(runtime.summaryEngine);
    expect(executable.llmCalls).toBe(runtime.metrics.llmCalls);
  });
});
