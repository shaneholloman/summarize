import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRunScopedMediaCache } from "../src/run/run-media-cache.js";

describe("run-scoped media cache", () => {
  it("keeps shared downloads alive for the run and removes them on cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-run-media-test-"));
    const source = join(root, "video.mp4");
    await writeFile(source, new Uint8Array([1, 2, 3]));
    const scope = await createRunScopedMediaCache(null);

    try {
      const stored = await scope.cache.put({
        url: "https://example.com/video#summarize-slides",
        filePath: source,
        mediaType: "video/mp4",
        filename: "video.mp4",
      });
      expect(stored?.filePath).not.toBe(source);
      await expect(access(source)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await scope.cache.get({ url: "https://example.com/video#summarize-slides" })).toEqual(
        stored,
      );

      await scope.cleanup();
      await expect(access(stored!.filePath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await scope.cleanup();
    }
  });
});
