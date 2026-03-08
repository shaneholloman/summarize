import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createLinkPreviewClient } from "../src/content/index.js";

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY ?? null;

const resolveYtDlpPath = (): string | null => {
  const explicit = process.env.YT_DLP_PATH?.trim();
  if (explicit) return explicit;
  const probe = spawnSync("yt-dlp", ["--version"], { stdio: "ignore" });
  return probe.status === 0 ? "yt-dlp" : null;
};

const YT_DLP_PATH = resolveYtDlpPath();
const LIVE =
  process.env.SUMMARIZE_LIVE_TESTS === "1" && Boolean(ASSEMBLYAI_API_KEY) && Boolean(YT_DLP_PATH);

describe("live YouTube transcript (yt-dlp + AssemblyAI)", () => {
  const run = LIVE ? it : it.skip;

  run(
    "transcribes a short video via yt-dlp using AssemblyAI",
    async () => {
      const url = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
      const env = {
        ...process.env,
        SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1",
        SUMMARIZE_ONNX_PARAKEET_CMD: "",
        SUMMARIZE_ONNX_CANARY_CMD: "",
        GROQ_API_KEY: "",
        GEMINI_API_KEY: "",
        GOOGLE_GENERATIVE_AI_API_KEY: "",
        GOOGLE_API_KEY: "",
        OPENAI_API_KEY: "",
        FAL_KEY: "",
        ASSEMBLYAI_API_KEY: ASSEMBLYAI_API_KEY ?? "",
      };

      const client = createLinkPreviewClient({
        env,
        ytDlpPath: YT_DLP_PATH,
      });
      const result = await client.fetchLinkContent(url, {
        timeoutMs: 300_000,
        cacheMode: "bypass",
        youtubeTranscript: "yt-dlp",
      });

      expect(result.transcriptSource).toBe("yt-dlp");
      expect(result.transcriptionProvider).toBe("assemblyai");
      expect(result.transcriptCharacters ?? 0).toBeGreaterThan(20);
      expect(result.content.toLowerCase()).toContain("elephant");
    },
    600_000,
  );
});
