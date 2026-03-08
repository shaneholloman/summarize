import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("transcription/whisper assemblyai", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("transcribes bytes via AssemblyAI upload and polling", async () => {
    let polls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/upload")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("AAI");
        expect(new Headers(init?.headers).get("content-type")).toBe("audio/mpeg");
        return new Response(JSON.stringify({ upload_url: "https://upload.example/audio" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/transcript")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          audio_url: "https://upload.example/audio",
          speech_models: ["universal-2"],
        });
        return new Response(JSON.stringify({ id: "tr_123", status: "queued" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/transcript/tr_123")) {
        polls += 1;
        return new Response(
          JSON.stringify(
            polls === 1
              ? { id: "tr_123", status: "processing" }
              : { id: "tr_123", status: "completed", text: "AssemblyAI transcript" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    vi.stubGlobal("fetch", fetchMock);
    const { transcribeMediaWithWhisper } =
      await import("../packages/core/src/transcription/whisper.js");

    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      groqApiKey: null,
      assemblyaiApiKey: "AAI",
      openaiApiKey: null,
      falApiKey: null,
    });

    expect(result.text).toBe("AssemblyAI transcript");
    expect(result.provider).toBe("assemblyai");
    expect(result.error).toBeNull();
    expect(polls).toBe(2);
  });

  it("transcribes files via AssemblyAI file upload flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "summarize-assemblyai-"));
    const audioPath = join(root, "clip.mp3");
    await writeFile(audioPath, new Uint8Array([1, 2, 3]));

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/upload")) {
        return new Response(JSON.stringify({ upload_url: "https://upload.example/file" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/transcript")) {
        return new Response(
          JSON.stringify({ id: "tr_file", status: "completed", text: "File transcript" }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    try {
      vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
      vi.stubGlobal("fetch", fetchMock);
      const { transcribeMediaFileWithWhisper } =
        await import("../packages/core/src/transcription/whisper.js");

      const result = await transcribeMediaFileWithWhisper({
        filePath: audioPath,
        mediaType: "audio/mpeg",
        filename: "clip.mp3",
        groqApiKey: null,
        assemblyaiApiKey: "AAI",
        openaiApiKey: null,
        falApiKey: null,
      });

      expect(result.text).toBe("File transcript");
      expect(result.provider).toBe("assemblyai");
      expect(result.error).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("falls back to OpenAI when AssemblyAI fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/upload")) {
        return new Response("nope", { status: 500, headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/audio/transcriptions")) {
        expect(init?.body).toBeInstanceOf(FormData);
        return new Response(JSON.stringify({ text: "OpenAI transcript" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubEnv("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP", "1");
    vi.stubGlobal("fetch", fetchMock);
    const { transcribeMediaWithWhisper } =
      await import("../packages/core/src/transcription/whisper.js");

    const result = await transcribeMediaWithWhisper({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      groqApiKey: null,
      assemblyaiApiKey: "AAI",
      openaiApiKey: "OPENAI",
      falApiKey: null,
    });

    expect(result.text).toBe("OpenAI transcript");
    expect(result.provider).toBe("openai");
    expect(result.notes.join(" ")).toContain(
      "AssemblyAI transcription failed; falling back to OpenAI",
    );
  });
});
