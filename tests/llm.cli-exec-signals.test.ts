import { describe, expect, it, vi } from "vitest";
import { CliInterruptedError, execCliWithInput } from "../src/llm/cli-exec.js";
import type { ExecFileFn } from "../src/markitdown.js";

describe("execCliWithInput signals", () => {
  it("forwards SIGINT to the active child and rejects as an interrupt", async () => {
    const beforeSigint = process.listenerCount("SIGINT");
    const beforeSigterm = process.listenerCount("SIGTERM");
    const kill = vi.fn();
    let callback: Parameters<ExecFileFn>[3] | undefined;

    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill,
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = execCliWithInput({
      execFileImpl,
      cmd: "slow-cli",
      args: [],
      input: "prompt",
      timeoutMs: 10_000,
      env: {},
    });

    process.emit("SIGINT");
    callback?.(Object.assign(new Error("interrupted"), { signal: "SIGINT", killed: true }), "", "");

    await expect(promise).rejects.toMatchObject({
      exitCode: 130,
      signal: "SIGINT",
      silent: true,
    });
    await expect(promise).rejects.toBeInstanceOf(CliInterruptedError);
    expect(kill).toHaveBeenCalledWith("SIGINT");
    expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
    expect(process.listenerCount("SIGTERM")).toBe(beforeSigterm);
  });

  it("forwards SIGTERM with terminate exit semantics", async () => {
    const kill = vi.fn();
    let callback: Parameters<ExecFileFn>[3] | undefined;

    const execFileImpl: ExecFileFn = ((_cmd, _args, _options, cb) => {
      callback = cb;
      return {
        kill,
        stdin: {
          write: vi.fn(),
          end: vi.fn(),
        },
      } as unknown as ReturnType<ExecFileFn>;
    }) as ExecFileFn;

    const promise = execCliWithInput({
      execFileImpl,
      cmd: "slow-cli",
      args: [],
      input: "prompt",
      timeoutMs: 10_000,
      env: {},
    });

    process.emit("SIGTERM");
    callback?.(Object.assign(new Error("terminated"), { signal: "SIGTERM", killed: true }), "", "");

    await expect(promise).rejects.toMatchObject({
      exitCode: 143,
      signal: "SIGTERM",
      silent: true,
    });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
