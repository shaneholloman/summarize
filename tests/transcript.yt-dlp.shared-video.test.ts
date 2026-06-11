import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSharedVideoMediaCacheKey } from "../packages/core/src/content/cache/types.js";
import { fetchTranscriptWithYtDlp } from "../packages/core/src/content/transcript/providers/youtube/yt-dlp.js";
import { createRunScopedMediaCache } from "../src/run/run-media-cache.js";

vi.mock("../packages/core/src/transcription/whisper/ffmpeg.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../packages/core/src/transcription/whisper/ffmpeg.js")>();
  return {
    ...actual,
    probeMediaDurationSecondsWithFfprobe: vi.fn(async () => 1),
  };
});

describe("yt-dlp shared slide video", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("downloads separate video and audio streams, uploads audio, and caches video", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-ytdlp-shared-test-"));
    const ytDlpPath = join(root, "yt-dlp");
    const argsPath = join(root, "args.txt");
    await writeFile(
      ytDlpPath,
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsPath)}
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '-o' ]; then
    shift
    output="$1"
  fi
  shift
done
audio=$(printf '%s' "$output" | sed 's/%(vcodec)s/none/; s/%(acodec)s/opus/; s/%(ext)s/webm/')
video=$(printf '%s' "$output" | sed 's/%(vcodec)s/avc1/; s/%(acodec)s/none/; s/%(ext)s/mp4/')
printf 'audio' > "$audio"
printf 'video-data' > "$video"
`,
    );
    await chmod(ytDlpPath, 0o755);
    const scope = await createRunScopedMediaCache(null);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      expect(file.name).toBe("media.none.opus.webm");
      expect(file.type).toBe("audio/webm");
      expect(file.size).toBe(5);
      return new Response(
        JSON.stringify({
          segments: [{ start: 0, end: 1, speaker: "A", text: "Shared." }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    vi.stubEnv("SUMMARIZE_ONNX_PARAKEET_CMD", "");
    vi.stubEnv("SUMMARIZE_ONNX_CANARY_CMD", "");
    const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

    try {
      const result = await fetchTranscriptWithYtDlp({
        ytDlpPath,
        openaiApiKey: "OPENAI",
        diarization: "openai",
        downloadVideo: true,
        mediaCache: scope.cache,
        url,
      });

      expect(result.text).toBe("Speaker A: Shared.");
      expect(result.notes).toContain("shared slide video cached");
      const cachedVideo = await scope.cache.get({
        url: buildSharedVideoMediaCacheKey(url),
      });
      expect(cachedVideo?.filename).toBe("media.avc1.none.mp4");
      expect(cachedVideo?.mediaType).toBe("video/mp4");
      expect(await readFile(cachedVideo!.filePath, "utf8")).toBe("video-data");

      const args = (await readFile(argsPath, "utf8")).split("\n");
      expect(args).toContain(
        "bestvideo[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/bestvideo[height<=720],bestaudio[vcodec=none]",
      );
      expect(args).not.toContain("-x");
      expect(args).not.toContain("--audio-format");
    } finally {
      await scope.cleanup();
      await rm(root, { recursive: true, force: true });
    }
  });
});
