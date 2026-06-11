import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { MAX_OPENAI_UPLOAD_BYTES } from "./constants.js";
import { formatDiarizedTranscript } from "./diarization-format.js";
import {
  ELEVENLABS_DIARIZATION_MODEL,
  transcribeFileWithElevenLabsDiarization,
} from "./elevenlabs.js";
import {
  isFfmpegAvailable,
  probeMediaDurationSecondsWithFfprobe,
  runFfmpegSegment,
  runFfmpegTranscodeToMp3,
} from "./ffmpeg.js";
import {
  OPENAI_DIARIZATION_MODEL,
  OpenAiTranscriptionHttpError,
  transcribeFileWithOpenAiDiarization,
} from "./openai.js";
import type {
  DiarizationPreference,
  DiarizationProvider,
  TranscriptionSegment,
  WhisperProgressEvent,
  WhisperTranscriptionResult,
} from "./types.js";
import { wrapError } from "./utils.js";

export const OPENAI_DIARIZATION_CHUNK_SECONDS = 8 * 60;
const OPENAI_DIARIZATION_CHUNK_CONCURRENCY = 1;
const OPENAI_DIARIZATION_CHUNK_ATTEMPTS = 3;
const VIDEO_EXTENSIONS = new Set([
  ".3gp",
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".ogv",
  ".ts",
  ".webm",
]);

type PreparedDiarizationMedia = {
  filePath: string;
  mediaType: string;
  filename: string | null;
  cleanupPath: string | null;
  note: string | null;
  optimizedForOpenAi: boolean;
};

export function resolveDiarizationProviderOrder({
  preference,
  elevenlabsApiKey,
  openaiApiKey,
}: {
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
}): DiarizationProvider[] {
  if (preference === "elevenlabs") return elevenlabsApiKey ? ["elevenlabs"] : [];
  if (preference === "openai") return openaiApiKey ? ["openai"] : [];
  return [
    ...(elevenlabsApiKey ? (["elevenlabs"] as const) : []),
    ...(openaiApiKey ? (["openai"] as const) : []),
  ];
}

export function buildDiarizationModelChain(providers: DiarizationProvider[]): string | null {
  const models = providers.map((provider) =>
    provider === "elevenlabs"
      ? `elevenlabs/${ELEVENLABS_DIARIZATION_MODEL}`
      : OPENAI_DIARIZATION_MODEL,
  );
  return models.length > 0 ? models.join("->") : null;
}

export async function transcribeMediaFileWithDiarization({
  filePath,
  mediaType,
  filename,
  preference,
  elevenlabsApiKey,
  openaiApiKey,
  env,
  totalDurationSeconds,
  onProgress,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  const providers = resolveDiarizationProviderOrder({
    preference,
    elevenlabsApiKey,
    openaiApiKey,
  });
  if (providers.length === 0) {
    return {
      text: null,
      provider: preference === "auto" ? null : preference,
      error: new Error(buildMissingDiarizationProviderMessage(preference)),
      notes: [],
      segments: null,
    };
  }

  const probedDurationSeconds = providers.includes("openai")
    ? await probeMediaDurationSecondsWithFfprobe(filePath)
    : null;
  const effectiveDurationSeconds =
    totalDurationSeconds !== null && probedDurationSeconds !== null
      ? Math.max(totalDurationSeconds, probedDurationSeconds)
      : (totalDurationSeconds ?? probedDurationSeconds);
  onProgress?.({
    partIndex: null,
    parts: null,
    processedDurationSeconds: null,
    totalDurationSeconds: effectiveDurationSeconds,
  });
  const notes: string[] = [];
  let lastError: Error | null = null;
  const preparedMedia = await prepareDiarizationMediaFile({
    filePath,
    mediaType,
    filename,
    providers,
    totalDurationSeconds: effectiveDurationSeconds,
  });
  if (preparedMedia.note) notes.push(preparedMedia.note);

  try {
    for (const [index, provider] of providers.entries()) {
      try {
        const result =
          provider === "elevenlabs"
            ? await transcribeFileWithElevenLabsDiarization({
                filePath: preparedMedia.filePath,
                mediaType: preparedMedia.mediaType,
                filename: preparedMedia.filename,
                apiKey: elevenlabsApiKey!,
              })
            : await transcribeOpenAiMediaFile({
                filePath: preparedMedia.filePath,
                mediaType: preparedMedia.mediaType,
                filename: preparedMedia.filename,
                apiKey: openaiApiKey!,
                env,
                totalDurationSeconds: effectiveDurationSeconds,
                onProgress,
                alreadyOptimized: preparedMedia.optimizedForOpenAi,
                original: { filePath, mediaType, filename },
              });
        return { ...result, notes: [...notes, ...result.notes] };
      } catch (caught) {
        lastError = wrapError(`${providerLabel(provider)} diarization failed`, caught);
        const next = providers[index + 1];
        if (next) {
          notes.push(
            `${providerLabel(provider)} diarization failed; falling back to ${providerLabel(next)}: ${lastError.message}`,
          );
        }
      }
    }

    return {
      text: null,
      provider: providers.at(-1) ?? null,
      error: lastError ?? new Error("Speaker diarization failed"),
      notes,
      segments: null,
    };
  } finally {
    if (preparedMedia.cleanupPath) await fs.unlink(preparedMedia.cleanupPath).catch(() => {});
  }
}

async function transcribeOpenAiMediaFile({
  filePath,
  mediaType,
  filename,
  apiKey,
  env,
  totalDurationSeconds,
  onProgress,
  alreadyOptimized,
  original,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  apiKey: string;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
  alreadyOptimized: boolean;
  original: {
    filePath: string;
    mediaType: string;
    filename: string | null;
  };
}): Promise<WhisperTranscriptionResult> {
  const shouldChunk =
    totalDurationSeconds !== null
      ? totalDurationSeconds > OPENAI_DIARIZATION_CHUNK_SECONDS
      : await isFfmpegAvailable();
  if (shouldChunk) {
    return await transcribeOpenAiMediaFileInChunks({
      filePath,
      apiKey,
      env,
      totalDurationSeconds,
      onProgress,
    });
  }

  const prepared = await prepareOpenAiDiarizationFile({
    filePath,
    mediaType,
    filename,
    totalDurationSeconds,
    alreadyOptimized,
    original,
  });
  try {
    const result = await transcribeFileWithOpenAiDiarization({
      filePath: prepared.filePath,
      mediaType: prepared.mediaType,
      filename: prepared.filename,
      apiKey,
      options: { env },
    });
    return {
      ...result,
      notes: prepared.note ? [prepared.note, ...result.notes] : result.notes,
    };
  } finally {
    if (prepared.cleanupPath) await fs.unlink(prepared.cleanupPath).catch(() => {});
  }
}

async function transcribeOpenAiMediaFileInChunks({
  filePath,
  apiKey,
  env,
  totalDurationSeconds,
  onProgress,
}: {
  filePath: string;
  apiKey: string;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  if (!(await isFfmpegAvailable())) {
    throw new Error("OpenAI diarization of long media requires ffmpeg to split it");
  }

  const chunkRoot = await fs.mkdtemp(join(tmpdir(), "summarize-diarize-openai-chunks-"));
  const chunkDurationSeconds =
    totalDurationSeconds === null
      ? OPENAI_DIARIZATION_CHUNK_SECONDS
      : resolveOpenAiDiarizationChunkSeconds(totalDurationSeconds);
  try {
    await runFfmpegSegment({
      inputPath: filePath,
      outputPattern: join(chunkRoot, "chunk-%05d.mp3"),
      segmentSeconds: chunkDurationSeconds,
    });
    const chunkPaths = (await fs.readdir(chunkRoot))
      .filter((name) => name.endsWith(".mp3"))
      .sort()
      .map((name) => join(chunkRoot, name));
    if (chunkPaths.length === 0) throw new Error("ffmpeg produced no OpenAI diarization chunks");
    let completedChunks = 0;
    const chunkResults = await mapWithConcurrency(
      chunkPaths,
      OPENAI_DIARIZATION_CHUNK_CONCURRENCY,
      async (chunkPath, chunkIndex) => {
        const result = await transcribeOpenAiChunkWithRetry({
          chunkPath,
          apiKey,
          env,
        });
        completedChunks += 1;
        onProgress?.({
          partIndex: completedChunks,
          parts: chunkPaths.length,
          processedDurationSeconds:
            totalDurationSeconds === null
              ? null
              : Math.min(completedChunks * chunkDurationSeconds, totalDurationSeconds),
          totalDurationSeconds,
        });
        return { chunkIndex, result };
      },
    );

    const segments = chunkResults
      .flatMap(({ chunkIndex, result }) => {
        return namespaceOpenAiChunkSegments(
          result.segments ?? [],
          chunkIndex,
          chunkDurationSeconds,
        );
      })
      .sort((left, right) => left.startMs - right.startMs);
    const text = formatDiarizedTranscript(segments);
    if (!text) throw new Error("OpenAI transcription returned no speaker-labelled segments");
    return {
      text,
      provider: "openai",
      error: null,
      notes: [
        `OpenAI diarization: split long media into ${chunkPaths.length} chunks of up to 8 minutes`,
      ],
      segments,
    };
  } finally {
    await fs.rm(chunkRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeOpenAiChunkWithRetry({
  chunkPath,
  apiKey,
  env,
}: {
  chunkPath: string;
  apiKey: string;
  env: Record<string, string | undefined>;
}): Promise<WhisperTranscriptionResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= OPENAI_DIARIZATION_CHUNK_ATTEMPTS; attempt += 1) {
    try {
      return await transcribeFileWithOpenAiDiarization({
        filePath: chunkPath,
        mediaType: "audio/mpeg",
        filename: basename(chunkPath),
        apiKey,
        options: { env, allowEmpty: true },
      });
    } catch (error) {
      lastError = error;
      if (attempt === OPENAI_DIARIZATION_CHUNK_ATTEMPTS || !isRetryableOpenAiError(error)) {
        throw error;
      }
      const retryAfterMs =
        error instanceof OpenAiTranscriptionHttpError ? error.retryAfterMs : null;
      const delayMs = (retryAfterMs ?? attempt * 10_000) + Math.floor(Math.random() * 1_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

export function isRetryableOpenAiError(error: unknown): boolean {
  if (error instanceof OpenAiTranscriptionHttpError) {
    return (
      error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500
    );
  }
  if (error instanceof DOMException) {
    return ["AbortError", "NetworkError", "TimeoutError"].includes(error.name);
  }
  if (!(error instanceof TypeError)) return false;
  if (/fetch|network|socket|connection|terminated/i.test(error.message)) return true;
  const causeCode =
    error.cause && typeof error.cause === "object" && "code" in error.cause
      ? String(error.cause.code)
      : "";
  return new Set([
    "EAI_AGAIN",
    "ECONNRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "EPIPE",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
  ]).has(causeCode);
}

export function resolveOpenAiDiarizationChunkSeconds(totalDurationSeconds: number): number {
  const chunkCount = Math.ceil(totalDurationSeconds / OPENAI_DIARIZATION_CHUNK_SECONDS);
  return Math.ceil(totalDurationSeconds / Math.max(1, chunkCount));
}

function namespaceOpenAiChunkSegments(
  segments: TranscriptionSegment[],
  chunkIndex: number,
  chunkDurationSeconds: number,
): TranscriptionSegment[] {
  const speakerOrdinals = new Map<string, number>();
  const offsetMs = chunkIndex * chunkDurationSeconds * 1_000;
  return segments.map((segment) => {
    if (!segment.speaker) throw new Error("OpenAI diarization segment has no speaker label");
    let ordinal = speakerOrdinals.get(segment.speaker);
    if (ordinal === undefined) {
      ordinal = speakerOrdinals.size + 1;
      speakerOrdinals.set(segment.speaker, ordinal);
    }
    return {
      ...segment,
      startMs: segment.startMs + offsetMs,
      endMs: segment.endMs == null ? null : segment.endMs + offsetMs,
      speaker: `Speaker ${chunkIndex * 1_000 + ordinal}`,
    };
  });
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  callback: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  let firstError: unknown = null;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length && firstError === null) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = await callback(values[index]!, index);
        } catch (error) {
          firstError ??= error;
        }
      }
    }),
  );
  if (firstError !== null) throw firstError;
  return results;
}

export async function transcribeMediaBytesWithDiarization({
  bytes,
  mediaType,
  filename,
  ...rest
}: {
  bytes: Uint8Array;
  mediaType: string;
  filename: string | null;
  preference: DiarizationPreference;
  elevenlabsApiKey: string | null;
  openaiApiKey: string | null;
  env: Record<string, string | undefined>;
  totalDurationSeconds: number | null;
  onProgress?: ((event: WhisperProgressEvent) => void) | null;
}): Promise<WhisperTranscriptionResult> {
  const tempPath = join(tmpdir(), `summarize-diarize-${randomUUID()}`);
  try {
    await fs.writeFile(tempPath, bytes);
    return await transcribeMediaFileWithDiarization({
      filePath: tempPath,
      mediaType,
      filename,
      ...rest,
    });
  } finally {
    await fs.unlink(tempPath).catch(() => {});
  }
}

export function buildMissingDiarizationProviderMessage(preference: DiarizationPreference): string {
  if (preference === "elevenlabs") {
    return "Speaker diarization with ElevenLabs requires ELEVENLABS_API_KEY";
  }
  if (preference === "openai") {
    return "Speaker diarization with OpenAI requires OPENAI_API_KEY";
  }
  return "Speaker diarization requires ELEVENLABS_API_KEY or OPENAI_API_KEY";
}

function providerLabel(provider: DiarizationProvider): string {
  return provider === "elevenlabs" ? "ElevenLabs" : "OpenAI";
}

async function prepareDiarizationMediaFile({
  filePath,
  mediaType,
  filename,
  providers,
  totalDurationSeconds,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  providers: DiarizationProvider[];
  totalDurationSeconds: number | null;
}): Promise<PreparedDiarizationMedia> {
  if (!isVideoMedia({ filePath, mediaType, filename })) {
    return {
      filePath,
      mediaType,
      filename,
      cleanupPath: null,
      note: null,
      optimizedForOpenAi: false,
    };
  }
  if (!(await isFfmpegAvailable())) {
    return {
      filePath,
      mediaType,
      filename,
      cleanupPath: null,
      note: "Diarization: local audio extraction unavailable; uploading the original video",
      optimizedForOpenAi: false,
    };
  }

  const optimizeForOpenAi = providers.includes("openai");
  const bitrateKbps = optimizeForOpenAi
    ? resolveOpenAiDiarizationBitrateKbps(totalDurationSeconds)
    : 32;
  const audioPath = join(tmpdir(), `summarize-diarize-audio-${randomUUID()}.mp3`);
  let handedOff = false;
  try {
    await runFfmpegTranscodeToMp3({
      inputPath: filePath,
      outputPath: audioPath,
      bitrateKbps,
    });
    handedOff = true;
    return {
      filePath: audioPath,
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      cleanupPath: audioPath,
      note: `Diarization: extracted audio from video as mono 16 kHz ${bitrateKbps} kbps MP3`,
      optimizedForOpenAi: optimizeForOpenAi,
    };
  } catch (caught) {
    return {
      filePath,
      mediaType,
      filename,
      cleanupPath: null,
      note: `Diarization: local audio extraction failed; uploading the original video: ${wrapError("ffmpeg", caught).message}`,
      optimizedForOpenAi: false,
    };
  } finally {
    if (!handedOff) await fs.unlink(audioPath).catch(() => {});
  }
}

function isVideoMedia({
  filePath,
  mediaType,
  filename,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
}): boolean {
  const normalizedMediaType = mediaType.trim().toLowerCase();
  if (normalizedMediaType.startsWith("video/")) return true;
  if (normalizedMediaType.startsWith("audio/")) return false;
  return VIDEO_EXTENSIONS.has(extname(filename?.trim() || filePath).toLowerCase());
}

async function prepareOpenAiDiarizationFile({
  filePath,
  mediaType,
  filename,
  totalDurationSeconds,
  alreadyOptimized,
  original,
}: {
  filePath: string;
  mediaType: string;
  filename: string | null;
  totalDurationSeconds: number | null;
  alreadyOptimized: boolean;
  original: {
    filePath: string;
    mediaType: string;
    filename: string | null;
  };
}): Promise<{
  filePath: string;
  mediaType: string;
  filename: string | null;
  cleanupPath: string | null;
  note: string | null;
}> {
  const stat = await fs.stat(filePath);
  if (stat.size <= MAX_OPENAI_UPLOAD_BYTES) {
    return { filePath, mediaType, filename, cleanupPath: null, note: null };
  }
  if (alreadyOptimized) {
    const originalStat = await fs.stat(original.filePath);
    if (originalStat.size <= MAX_OPENAI_UPLOAD_BYTES) {
      return {
        ...original,
        cleanupPath: null,
        note: "OpenAI diarization: extracted audio exceeded the upload limit; using the smaller original video",
      };
    }
    throw new Error(
      "OpenAI diarization audio remains above the upload limit after local extraction; use ElevenLabs or a shorter recording",
    );
  }
  if (!(await isFfmpegAvailable())) {
    throw new Error(
      "OpenAI diarization media exceeds the upload limit; install ffmpeg to compress it",
    );
  }

  const compressedPath = join(tmpdir(), `summarize-diarize-openai-${randomUUID()}.mp3`);
  const bitrateKbps = resolveOpenAiDiarizationBitrateKbps(totalDurationSeconds);
  let handedOff = false;
  try {
    await runFfmpegTranscodeToMp3({
      inputPath: filePath,
      outputPath: compressedPath,
      bitrateKbps,
    });
    const compressedStat = await fs.stat(compressedPath);
    if (compressedStat.size > MAX_OPENAI_UPLOAD_BYTES) {
      throw new Error("OpenAI diarization media remains above the upload limit after compression");
    }
    handedOff = true;
    return {
      filePath: compressedPath,
      mediaType: "audio/mpeg",
      filename: "audio.mp3",
      cleanupPath: compressedPath,
      note: `OpenAI diarization: compressed oversized media to ${bitrateKbps} kbps MP3`,
    };
  } finally {
    if (!handedOff) await fs.unlink(compressedPath).catch(() => {});
  }
}

export function resolveOpenAiDiarizationBitrateKbps(
  totalDurationSeconds: number | null,
): 8 | 12 | 16 | 24 {
  if (
    !Number.isFinite(totalDurationSeconds) ||
    totalDurationSeconds === null ||
    totalDurationSeconds <= 0
  ) {
    return 24;
  }
  const targetKbps = ((MAX_OPENAI_UPLOAD_BYTES * 8) / (totalDurationSeconds * 1_000)) * 0.95;
  return ([24, 16, 12, 8] as const).find((bitrate) => bitrate <= targetKbps) ?? 8;
}
