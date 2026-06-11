import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { MediaCache, MediaCacheEntry } from "../content/index.js";

export async function createRunScopedMediaCache(
  backing: MediaCache | null,
): Promise<{ cache: MediaCache; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(join(tmpdir(), "summarize-run-media-"));
  const entries = new Map<string, MediaCacheEntry>();

  const cache: MediaCache = {
    get: async ({ url }) => {
      const local = entries.get(url);
      if (local) {
        try {
          await fs.access(local.filePath);
          local.lastAccessAtMs = Date.now();
          return local;
        } catch {
          entries.delete(url);
        }
      }
      return (await backing?.get({ url })) ?? null;
    },
    put: async ({ url, filePath, mediaType = null, filename = null }) => {
      const persisted = await backing?.put({ url, filePath, mediaType, filename });
      if (persisted) return persisted;

      const suffix = extname(filename?.trim() || filePath) || ".bin";
      const destination = join(dir, `${randomUUID()}${suffix}`);
      try {
        await fs.rename(filePath, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
        await fs.copyFile(filePath, destination);
        await fs.rm(filePath, { force: true });
      }
      const stat = await fs.stat(destination);
      const now = Date.now();
      const entry: MediaCacheEntry = {
        url,
        filePath: destination,
        sizeBytes: stat.size,
        sha256: null,
        mediaType,
        filename,
        createdAtMs: now,
        lastAccessAtMs: now,
        expiresAtMs: null,
      };
      entries.set(url, entry);
      return entry;
    },
  };

  return {
    cache,
    cleanup: async () => {
      entries.clear();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
