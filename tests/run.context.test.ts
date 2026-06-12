import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunConfigInput } from "../src/application/config-state.js";
import { resolveRunContextState } from "../src/application/context.js";

describe("run context state", () => {
  it("combines config + env resolution", () => {
    const root = mkdtempSync(join(tmpdir(), "summarize-context-"));
    const configDir = join(root, ".summarize");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        model: "openai/gpt-5-mini",
        openai: { useChatCompletions: true },
      }),
      "utf8",
    );

    const env = {
      HOME: root,
      OPENAI_API_KEY: "oa-key",
      OPENROUTER_API_KEY: "or-key",
    };

    const state = resolveRunContextState({
      env,
      envForRun: env,
      configInput: createRunConfigInput(),
    });

    expect(state.configModelLabel).toBe("openai/gpt-5-mini");
    expect(state.openaiUseChatCompletions).toBe(true);
    expect(state.openrouterApiKey).toBe("or-key");
    expect(state.apiKey).toBe("oa-key");
    expect(state.envForAuto.OPENROUTER_API_KEY).toBe("or-key");
  });
});
