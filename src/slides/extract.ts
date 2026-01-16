import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { ExtractedLinkContent } from '../content/index.js'
import { extractYouTubeVideoId, isDirectMediaUrl, isYouTubeUrl } from '../content/index.js'
import { resolveExecutableInPath } from '../run/env.js'
import type { SlideSettings } from './settings.js'
import type {
  SlideAutoTune,
  SlideExtractionResult,
  SlideImage,
  SlideSource,
  SlideSourceKind,
} from './types.js'

const FFMPEG_TIMEOUT_FALLBACK_MS = 300_000
const slidesLocks = new Map<string, Promise<void>>()
const YT_DLP_TIMEOUT_MS = 300_000
const TESSERACT_TIMEOUT_MS = 120_000
const DEFAULT_SLIDES_WORKERS = 8
const DEFAULT_SLIDES_SAMPLE_COUNT = 8
// Prefer broadly-decodable H.264/MP4 for ffmpeg stability.
// (Some "bestvideo" picks AV1 which can fail on certain ffmpeg builds / hwaccel setups.)
const DEFAULT_YT_DLP_FORMAT_DETECT =
  'best[height<=360][vcodec^=avc1][ext=mp4]/best[height<=360][ext=mp4]/best[height<=360]/best'
const DEFAULT_YT_DLP_FORMAT_EXTRACT =
  'bestvideo[height<=720][vcodec^=avc1][ext=mp4]/best[height<=720][vcodec^=avc1][ext=mp4]/bestvideo[height<=720][ext=mp4]/best[height<=720]'

function logSlides(message: string): void {
  console.log(`[summarize-slides] ${message}`)
}

function logSlidesTiming(label: string, startedAt: number): number {
  const elapsedMs = Date.now() - startedAt
  logSlides(`${label} elapsedMs=${elapsedMs}`)
  return elapsedMs
}

function resolveSlidesWorkers(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_WORKERS ?? env.SLIDES_WORKERS
  if (!raw) return DEFAULT_SLIDES_WORKERS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_WORKERS
  return Math.max(1, Math.min(16, Math.round(parsed)))
}

function resolveSlidesSampleCount(env: Record<string, string | undefined>): number {
  const raw = env.SUMMARIZE_SLIDES_SAMPLES ?? env.SLIDES_SAMPLES
  if (!raw) return DEFAULT_SLIDES_SAMPLE_COUNT
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SLIDES_SAMPLE_COUNT
  return Math.max(3, Math.min(12, Math.round(parsed)))
}

function resolveSlidesYtDlpDetectFormat(env: Record<string, string | undefined>): string {
  return (
    env.SUMMARIZE_SLIDES_YTDLP_FORMAT ??
    env.SLIDES_YTDLP_FORMAT ??
    DEFAULT_YT_DLP_FORMAT_DETECT
  ).trim()
}

function resolveSlidesYtDlpExtractFormat(env: Record<string, string | undefined>): string {
  return (
    env.SUMMARIZE_SLIDES_YTDLP_FORMAT_EXTRACT ??
    env.SLIDES_YTDLP_FORMAT_EXTRACT ??
    DEFAULT_YT_DLP_FORMAT_EXTRACT
  ).trim()
}

function resolveSlidesExtractStream(env: Record<string, string | undefined>): boolean {
  const raw = env.SUMMARIZE_SLIDES_EXTRACT_STREAM ?? env.SLIDES_EXTRACT_STREAM
  // Default to downloading a local video file for frame extraction.
  // Streaming extraction via `ffmpeg -i <googlevideo url>` is fragile (throttling/403s) and can look "stuck"
  // in the UI (no thumbnails) for long periods.
  if (raw == null) return false
  if (typeof raw === 'boolean') return raw
  const normalized = String(raw).trim().toLowerCase()
  if (!normalized) return false
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return false
}

function resolveToolPath(
  binary: string,
  env: Record<string, string | undefined>,
  explicitEnvKey?: string
): string | null {
  const explicit =
    explicitEnvKey && typeof env[explicitEnvKey] === 'string' ? env[explicitEnvKey]?.trim() : ''
  if (explicit) return resolveExecutableInPath(explicit, env)
  return resolveExecutableInPath(binary, env)
}

type ExtractSlidesArgs = {
  source: SlideSource
  settings: SlideSettings
  noCache?: boolean
  env: Record<string, string | undefined>
  timeoutMs: number
  ytDlpPath: string | null
  ffmpegPath: string | null
  tesseractPath: string | null
  hooks?: {
    onSlideChunk?: (chunk: {
      slide: SlideImage
      meta: {
        slidesDir: string
        sourceUrl: string
        sourceId: string
        sourceKind: SlideSourceKind
        ocrAvailable: boolean
      }
    }) => void
    onSlidesProgress?: ((text: string) => void) | null
  } | null
}

export function resolveSlideSource({
  url,
  extracted,
}: {
  url: string
  extracted: ExtractedLinkContent
}): SlideSource | null {
  const directUrl = extracted.video?.url ?? extracted.url
  const youtubeCandidate =
    extractYouTubeVideoId(extracted.video?.url ?? '') ??
    extractYouTubeVideoId(extracted.url) ??
    extractYouTubeVideoId(url)
  if (youtubeCandidate) {
    return {
      url: `https://www.youtube.com/watch?v=${youtubeCandidate}`,
      kind: 'youtube',
      sourceId: youtubeCandidate,
    }
  }

  if (extracted.video?.kind === 'direct' || isDirectMediaUrl(directUrl) || isDirectMediaUrl(url)) {
    const normalized = directUrl || url
    return {
      url: normalized,
      kind: 'direct',
      sourceId: buildDirectSourceId(normalized),
    }
  }

  if (isYouTubeUrl(url)) {
    const fallbackId = extractYouTubeVideoId(url)
    if (fallbackId) {
      return {
        url: `https://www.youtube.com/watch?v=${fallbackId}`,
        kind: 'youtube',
        sourceId: fallbackId,
      }
    }
  }

  return null
}

export async function extractSlidesForSource({
  source,
  settings,
  noCache = false,
  env,
  timeoutMs,
  ytDlpPath,
  ffmpegPath,
  tesseractPath,
  hooks,
}: ExtractSlidesArgs): Promise<SlideExtractionResult> {
  const slidesDir = path.join(settings.outputDir, source.sourceId)
  return withSlidesLock(
    slidesDir,
    async () => {
      if (!noCache) {
        const cached = await readSlidesCacheIfValid({ slidesDir, source, settings })
        if (cached) {
          return cached
        }
      }

      const reportSlidesProgress = (() => {
        const onSlidesProgress = hooks?.onSlidesProgress
        if (!onSlidesProgress) return null
        let lastText = ''
        let lastPercent = 0
        return (label: string, percent: number, detail?: string) => {
          const clamped = clamp(Math.round(percent), 0, 100)
          const nextPercent = Math.max(lastPercent, clamped)
          const suffix = detail ? ` ${detail}` : ''
          const text = `Slides: ${label}${suffix} ${nextPercent}%`
          if (text === lastText) return
          lastText = text
          lastPercent = nextPercent
          onSlidesProgress(text)
        }
      })()

      const warnings: string[] = []
      const workers = resolveSlidesWorkers(env)
      const totalStartedAt = Date.now()
      logSlides(
        `pipeline=ingest(sequential)->scene-detect(parallel:${workers})->extract-frames(parallel:${workers})->ocr(parallel:${workers})`
      )

      const ffmpegBinary = ffmpegPath ?? resolveToolPath('ffmpeg', env, 'FFMPEG_PATH')
      if (!ffmpegBinary) {
        throw new Error('Missing ffmpeg (install ffmpeg or add it to PATH).')
      }
      const ffprobeBinary = resolveToolPath('ffprobe', env, 'FFPROBE_PATH')

      if (settings.ocr && !tesseractPath) {
        const resolved = resolveToolPath('tesseract', env, 'TESSERACT_PATH')
        if (!resolved) {
          throw new Error('Missing tesseract OCR (install tesseract or skip --slides-ocr).')
        }
        tesseractPath = resolved
      }
      const ocrEnabled = Boolean(settings.ocr && tesseractPath)
      const ocrAvailable = Boolean(
        tesseractPath ?? resolveToolPath('tesseract', env, 'TESSERACT_PATH')
      )

      const P_PREPARE = 2
      const P_FETCH_VIDEO = 6
      const P_DOWNLOAD_VIDEO = 35
      const P_DETECT_SCENES = 60
      const P_EXTRACT_DOWNLOAD = 75
      const P_EXTRACT_FRAMES = 90
      const P_OCR = 99
      const P_FINAL = 100

      {
        const prepareStartedAt = Date.now()
        await prepareSlidesDir(slidesDir)
        logSlidesTiming('prepare output dir', prepareStartedAt)
      }
      reportSlidesProgress?.('preparing source', P_PREPARE)

      let detectionInputPath = source.url
      let detectionCleanup: (() => Promise<void>) | null = null
      let extractionCleanup: (() => Promise<void>) | null = null
      let detectionUsesStream = false

      if (source.kind === 'youtube') {
        if (!ytDlpPath) {
          throw new Error('Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).')
        }
        const ytDlp = ytDlpPath
        const format = resolveSlidesYtDlpDetectFormat(env)
        reportSlidesProgress?.('fetching video', P_FETCH_VIDEO)
        const streamStartedAt = Date.now()
        try {
          const streamUrl = await resolveYoutubeStreamUrl({
            ytDlpPath: ytDlp,
            url: source.url,
            format,
            timeoutMs,
          })
          detectionInputPath = streamUrl
          detectionUsesStream = true
          logSlidesTiming(`yt-dlp stream url (detect, format=${format})`, streamStartedAt)
        } catch (error) {
          warnings.push(`Failed to resolve detection stream URL: ${String(error)}`)
          reportSlidesProgress?.('downloading video', P_FETCH_VIDEO)
          const downloadStartedAt = Date.now()
          const downloaded = await downloadYoutubeVideo({
            ytDlpPath: ytDlp,
            url: source.url,
            timeoutMs,
            format,
            onProgress: (percent, detail) => {
              const ratio = clamp(percent / 100, 0, 1)
              const mapped = P_FETCH_VIDEO + ratio * (P_DOWNLOAD_VIDEO - P_FETCH_VIDEO)
              reportSlidesProgress?.('downloading video', mapped, detail)
            },
          })
          detectionInputPath = downloaded.filePath
          detectionCleanup = downloaded.cleanup
          logSlidesTiming(`yt-dlp download (detect, format=${format})`, downloadStartedAt)
        }
      }

      try {
        const ffmpegStartedAt = Date.now()
        reportSlidesProgress?.('detecting scenes', P_FETCH_VIDEO + 2)
        const detect = async () =>
          detectSlideTimestamps({
            ffmpegPath: ffmpegBinary,
            ffprobePath: ffprobeBinary,
            inputPath: detectionInputPath,
            sceneThreshold: settings.sceneThreshold,
            autoTuneThreshold: settings.autoTuneThreshold,
            env,
            timeoutMs,
            warnings,
            workers,
            sampleCount: resolveSlidesSampleCount(env),
            onSegmentProgress: (completed, total) => {
              const ratio = total > 0 ? completed / total : 0
              const mapped = P_FETCH_VIDEO + 2 + ratio * (P_DETECT_SCENES - (P_FETCH_VIDEO + 2))
              reportSlidesProgress?.(
                'detecting scenes',
                mapped,
                total > 0 ? `(${completed}/${total})` : undefined
              )
            },
          })
        let detection: Awaited<ReturnType<typeof detect>>
        try {
          detection = await detect()
          reportSlidesProgress?.('detecting scenes', P_DETECT_SCENES)
          logSlidesTiming('ffmpeg scene-detect', ffmpegStartedAt)
        } catch (error) {
          if (source.kind !== 'youtube' || !detectionUsesStream) {
            throw error
          }
          warnings.push(`Scene detection failed on stream URL; retrying download: ${String(error)}`)
          if (!ytDlpPath) {
            throw new Error(
              'Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).'
            )
          }
          const format = resolveSlidesYtDlpDetectFormat(env)
          reportSlidesProgress?.('downloading video', P_FETCH_VIDEO)
          const downloadStartedAt = Date.now()
          const downloaded = await downloadYoutubeVideo({
            ytDlpPath,
            url: source.url,
            timeoutMs,
            format,
            onProgress: (percent, detail) => {
              const ratio = clamp(percent / 100, 0, 1)
              const mapped = P_FETCH_VIDEO + ratio * (P_DOWNLOAD_VIDEO - P_FETCH_VIDEO)
              reportSlidesProgress?.('downloading video', mapped, detail)
            },
          })
          detectionInputPath = downloaded.filePath
          detectionCleanup = downloaded.cleanup
          detectionUsesStream = false
          logSlidesTiming(`yt-dlp download (detect, format=${format})`, downloadStartedAt)
          const retryStartedAt = Date.now()
          detection = await detect()
          reportSlidesProgress?.('detecting scenes', P_DETECT_SCENES)
          logSlidesTiming('ffmpeg scene-detect (retry)', retryStartedAt)
        }

        if (source.kind === 'youtube' && detectionUsesStream && detection.timestamps.length === 0) {
          warnings.push(
            'Scene detection returned zero timestamps on stream URL; retrying download.'
          )
          if (!ytDlpPath) {
            throw new Error(
              'Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).'
            )
          }
          const format = resolveSlidesYtDlpDetectFormat(env)
          reportSlidesProgress?.('downloading video', P_FETCH_VIDEO)
          const downloadStartedAt = Date.now()
          const downloaded = await downloadYoutubeVideo({
            ytDlpPath,
            url: source.url,
            timeoutMs,
            format,
            onProgress: (percent, detail) => {
              const ratio = clamp(percent / 100, 0, 1)
              const mapped = P_FETCH_VIDEO + ratio * (P_DOWNLOAD_VIDEO - P_FETCH_VIDEO)
              reportSlidesProgress?.('downloading video', mapped, detail)
            },
          })
          detectionInputPath = downloaded.filePath
          detectionCleanup = downloaded.cleanup
          detectionUsesStream = false
          logSlidesTiming(`yt-dlp download (detect, format=${format})`, downloadStartedAt)
          const retryStartedAt = Date.now()
          detection = await detect()
          reportSlidesProgress?.('detecting scenes', P_DETECT_SCENES)
          logSlidesTiming('ffmpeg scene-detect (retry)', retryStartedAt)
        }

        let extractionInputPath = detectionInputPath
        let extractionUsesStream = detectionUsesStream
        if (source.kind === 'youtube') {
          if (!ytDlpPath) {
            throw new Error(
              'Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).'
            )
          }
          const extractionFormat = resolveSlidesYtDlpExtractFormat(env)
          const detectionFormat = resolveSlidesYtDlpDetectFormat(env)
          if (resolveSlidesExtractStream(env)) {
            reportSlidesProgress?.('fetching video', P_DETECT_SCENES)
            const streamStartedAt = Date.now()
            try {
              const streamUrl = await resolveYoutubeStreamUrl({
                ytDlpPath,
                url: source.url,
                format: extractionFormat,
                timeoutMs,
              })
              extractionInputPath = streamUrl
              extractionUsesStream = true
              logSlidesTiming(
                `yt-dlp stream url (extract, format=${extractionFormat})`,
                streamStartedAt
              )
            } catch (error) {
              warnings.push(`Failed to resolve stream URL: ${String(error)}`)
            }
          }

          if (extractionInputPath === detectionInputPath && extractionFormat !== detectionFormat) {
            reportSlidesProgress?.('downloading video', P_DETECT_SCENES)
            const extractDownloadStartedAt = Date.now()
            const extracted = await downloadYoutubeVideo({
              ytDlpPath,
              url: source.url,
              timeoutMs,
              format: extractionFormat,
              onProgress: (percent, detail) => {
                const ratio = clamp(percent / 100, 0, 1)
                const mapped = P_DETECT_SCENES + ratio * (P_EXTRACT_DOWNLOAD - P_DETECT_SCENES)
                reportSlidesProgress?.('downloading video', mapped, detail)
              },
            })
            extractionInputPath = extracted.filePath
            extractionCleanup = extracted.cleanup
            extractionUsesStream = false
            logSlidesTiming(
              `yt-dlp download (extract, format=${extractionFormat})`,
              extractDownloadStartedAt
            )
          }
        }

        const interval = buildIntervalTimestamps({
          durationSeconds: detection.durationSeconds,
          minDurationSeconds: settings.minDurationSeconds,
          maxSlides: settings.maxSlides,
        })
        const combined = mergeTimestamps(
          detection.timestamps,
          interval?.timestamps ?? [],
          settings.minDurationSeconds
        )
        if (combined.length === 0) {
          throw new Error('No slides detected; try adjusting slide extraction settings.')
        }
        const selected = interval?.timestamps.length
          ? selectTimestampTargets({
              targets: interval.timestamps,
              sceneTimestamps: detection.timestamps,
              minDurationSeconds: settings.minDurationSeconds,
              intervalSeconds: interval.intervalSeconds,
            })
          : combined
        const spaced = filterTimestampsByMinDuration(selected, settings.minDurationSeconds)
        const trimmed = applyMaxSlidesFilter(
          spaced.map((timestamp, index) => ({ index: index + 1, timestamp, imagePath: '' })),
          settings.maxSlides,
          warnings
        )

        // Emit placeholders immediately so the UI can render the slide list while frames are still extracting.
        if (hooks?.onSlideChunk) {
          const meta = {
            slidesDir,
            sourceUrl: source.url,
            sourceId: source.sourceId,
            sourceKind: source.kind,
            ocrAvailable,
          }
          for (const slide of trimmed) {
            hooks.onSlideChunk({ slide: { ...slide, imagePath: '' }, meta })
          }
        }

        const formatProgressCount = (completed: number, total: number) =>
          total > 0 ? `(${completed}/${total})` : ''
        const reportFrameProgress = (completed: number, total: number) => {
          const ratio = total > 0 ? completed / total : 0
          reportSlidesProgress?.(
            'extracting frames',
            P_DETECT_SCENES + ratio * (P_EXTRACT_FRAMES - P_DETECT_SCENES),
            formatProgressCount(completed, total)
          )
        }
        reportFrameProgress(0, trimmed.length)

        const onSlideChunk = hooks?.onSlideChunk
        const extractFrames = async () =>
          extractFramesAtTimestamps({
            ffmpegPath: ffmpegBinary,
            inputPath: extractionInputPath,
            outputDir: slidesDir,
            timestamps: trimmed.map((slide) => slide.timestamp),
            durationSeconds: detection.durationSeconds,
            timeoutMs,
            workers,
            onProgress: reportFrameProgress,
            onStatus: hooks?.onSlidesProgress ?? null,
            onSlide: onSlideChunk
              ? (slide) =>
                  onSlideChunk({
                    slide,
                    meta: {
                      slidesDir,
                      sourceUrl: source.url,
                      sourceId: source.sourceId,
                      sourceKind: source.kind,
                      ocrAvailable,
                    },
                  })
              : null,
          })
        const extractFramesStartedAt = Date.now()
        let extractedSlides: SlideImage[]
        try {
          extractedSlides = await extractFrames()
        } catch (error) {
          if (source.kind !== 'youtube' || !extractionUsesStream) {
            throw error
          }
          warnings.push(
            `Frame extraction failed on stream URL; retrying download: ${String(error)}`
          )
          if (!ytDlpPath) {
            throw new Error(
              'Slides for YouTube require yt-dlp (set YT_DLP_PATH or install yt-dlp).'
            )
          }
          const extractionFormat = resolveSlidesYtDlpExtractFormat(env)
          reportSlidesProgress?.('downloading video', P_DETECT_SCENES)
          const extractDownloadStartedAt = Date.now()
          const downloaded = await downloadYoutubeVideo({
            ytDlpPath,
            url: source.url,
            timeoutMs,
            format: extractionFormat,
            onProgress: (percent, detail) => {
              const ratio = clamp(percent / 100, 0, 1)
              const mapped = P_DETECT_SCENES + ratio * (P_EXTRACT_DOWNLOAD - P_DETECT_SCENES)
              reportSlidesProgress?.('downloading video', mapped, detail)
            },
          })
          if (extractionCleanup) {
            await extractionCleanup()
          }
          extractionCleanup = downloaded.cleanup
          extractionInputPath = downloaded.filePath
          extractionUsesStream = false
          await prepareSlidesDir(slidesDir)
          logSlidesTiming(
            `yt-dlp download (extract retry, format=${extractionFormat})`,
            extractDownloadStartedAt
          )
          const retryStartedAt = Date.now()
          extractedSlides = await extractFrames()
          logSlidesTiming('extract frames (retry)', retryStartedAt)
        }
        const extractElapsedMs = logSlidesTiming(
          `extract frames (count=${trimmed.length}, parallel=${workers})`,
          extractFramesStartedAt
        )
        if (trimmed.length > 0) {
          logSlides(`extract frames avgMsPerFrame=${Math.round(extractElapsedMs / trimmed.length)}`)
        }

        const rawSlides = applyMinDurationFilter(
          extractedSlides,
          settings.minDurationSeconds,
          warnings
        )

        const renameStartedAt = Date.now()
        const renamedSlides = await renameSlidesWithTimestamps(rawSlides, slidesDir)
        logSlidesTiming('rename slides', renameStartedAt)
        if (renamedSlides.length === 0) {
          throw new Error('No slides extracted; try lowering --slides-scene-threshold.')
        }

        let slidesWithOcr = renamedSlides
        if (ocrEnabled && tesseractPath) {
          const ocrStartedAt = Date.now()
          logSlides(`ocr start count=${renamedSlides.length} mode=parallel workers=${workers}`)
          const ocrStartPercent = P_OCR - 3
          const reportOcrProgress = (completed: number, total: number) => {
            const ratio = total > 0 ? completed / total : 0
            reportSlidesProgress?.(
              'running OCR',
              ocrStartPercent + ratio * (P_OCR - ocrStartPercent),
              formatProgressCount(completed, total)
            )
          }
          reportOcrProgress(0, renamedSlides.length)
          slidesWithOcr = await runOcrOnSlides(
            renamedSlides,
            tesseractPath,
            workers,
            reportOcrProgress
          )
          const elapsedMs = logSlidesTiming('ocr done', ocrStartedAt)
          if (renamedSlides.length > 0) {
            logSlides(`ocr avgMsPerSlide=${Math.round(elapsedMs / renamedSlides.length)}`)
          }
        }

        reportSlidesProgress?.('finalizing', P_FINAL - 1)

        if (hooks?.onSlideChunk) {
          for (const slide of slidesWithOcr) {
            hooks.onSlideChunk({
              slide,
              meta: {
                slidesDir,
                sourceUrl: source.url,
                sourceId: source.sourceId,
                sourceKind: source.kind,
                ocrAvailable,
              },
            })
          }
        }

        const result: SlideExtractionResult = {
          sourceUrl: source.url,
          sourceKind: source.kind,
          sourceId: source.sourceId,
          slidesDir,
          sceneThreshold: settings.sceneThreshold,
          autoTuneThreshold: settings.autoTuneThreshold,
          autoTune: detection.autoTune,
          maxSlides: settings.maxSlides,
          minSlideDuration: settings.minDurationSeconds,
          ocrRequested: settings.ocr,
          ocrAvailable,
          slides: slidesWithOcr,
          warnings,
        }

        await writeSlidesJson(result, slidesDir)
        reportSlidesProgress?.('finalizing', P_FINAL)
        logSlidesTiming('slides total', totalStartedAt)
        return result
      } finally {
        if (extractionCleanup) {
          await extractionCleanup()
        }
        if (detectionCleanup) {
          await detectionCleanup()
        }
      }
    },
    () => {
      hooks?.onSlidesProgress?.('Slides: queued')
    }
  )
}

export function parseShowinfoTimestamp(line: string): number | null {
  if (!line.includes('showinfo')) return null
  const match = /pts_time:(\d+\.?\d*)/.exec(line)
  if (!match) return null
  const ts = Number(match[1])
  if (!Number.isFinite(ts)) return null
  return ts
}

async function prepareSlidesDir(slidesDir: string): Promise<void> {
  await fs.mkdir(slidesDir, { recursive: true })
  const entries = await fs.readdir(slidesDir)
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.startsWith('slide_') && entry.endsWith('.png')) {
        await fs.rm(path.join(slidesDir, entry), { force: true })
      }
      if (entry === 'slides.json') {
        await fs.rm(path.join(slidesDir, entry), { force: true })
      }
    })
  )
}

async function downloadYoutubeVideo({
  ytDlpPath,
  url,
  timeoutMs,
  format,
  onProgress,
}: {
  ytDlpPath: string
  url: string
  timeoutMs: number
  format: string
  onProgress?: ((percent: number, detail?: string) => void) | null
}): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), `summarize-slides-${randomUUID()}-`))
  const outputTemplate = path.join(dir, 'video.%(ext)s')
  const args = [
    '-f',
    format,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '-o',
    outputTemplate,
    url,
  ]
  await runProcess({
    command: ytDlpPath,
    args,
    timeoutMs: Math.max(timeoutMs, YT_DLP_TIMEOUT_MS),
    errorLabel: 'yt-dlp',
    onStderrLine: (line) => {
      if (!onProgress) return
      const trimmed = line.trim()
      if (!trimmed.startsWith('[download]')) return
      const percentMatch = trimmed.match(/\b(\d{1,3}(?:\.\d+)?)%\b/)
      if (!percentMatch) return
      const percent = Number(percentMatch[1])
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) return
      const etaMatch = trimmed.match(/\bETA\s+(\S+)\b/)
      const speedMatch = trimmed.match(/\bat\s+(\S+)\b/)
      const detailParts = [
        speedMatch?.[1] ? `at ${speedMatch[1]}` : null,
        etaMatch?.[1] ? `ETA ${etaMatch[1]}` : null,
      ].filter(Boolean)
      onProgress(percent, detailParts.length ? detailParts.join(' ') : undefined)
    },
  })

  const files = await fs.readdir(dir)
  const candidates = []
  for (const entry of files) {
    if (entry.endsWith('.part') || entry.endsWith('.ytdl')) continue
    const filePath = path.join(dir, entry)
    const stat = await fs.stat(filePath).catch(() => null)
    if (stat?.isFile()) {
      candidates.push({ filePath, size: stat.size })
    }
  }
  if (candidates.length === 0) {
    await fs.rm(dir, { recursive: true, force: true })
    throw new Error('yt-dlp completed but no video file was downloaded.')
  }
  candidates.sort((a, b) => b.size - a.size)
  const filePath = candidates[0].filePath
  return {
    filePath,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function resolveYoutubeStreamUrl({
  ytDlpPath,
  url,
  timeoutMs,
  format,
}: {
  ytDlpPath: string
  url: string
  timeoutMs: number
  format: string
}): Promise<string> {
  const args = ['-f', format, '-g', url]
  const output = await runProcessCapture({
    command: ytDlpPath,
    args,
    timeoutMs: Math.max(timeoutMs, YT_DLP_TIMEOUT_MS),
    errorLabel: 'yt-dlp',
  })
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) {
    throw new Error('yt-dlp did not return a stream URL.')
  }
  return lines[0]
}

async function detectSlideTimestamps({
  ffmpegPath,
  ffprobePath,
  inputPath,
  sceneThreshold,
  autoTuneThreshold,
  env,
  timeoutMs,
  warnings,
  workers,
  sampleCount,
  onSegmentProgress,
}: {
  ffmpegPath: string
  ffprobePath: string | null
  inputPath: string
  sceneThreshold: number
  autoTuneThreshold: boolean
  env: Record<string, string | undefined>
  timeoutMs: number
  warnings: string[]
  workers: number
  sampleCount: number
  onSegmentProgress?: ((completed: number, total: number) => void) | null
}): Promise<{ timestamps: number[]; autoTune: SlideAutoTune; durationSeconds: number | null }> {
  const probeStartedAt = Date.now()
  const videoInfo = await probeVideoInfo({
    ffprobePath,
    env,
    inputPath,
    timeoutMs,
  })
  logSlidesTiming('ffprobe video info', probeStartedAt)

  const calibration = await calibrateSceneThreshold({
    ffmpegPath,
    inputPath,
    durationSeconds: videoInfo.durationSeconds,
    sampleCount,
    timeoutMs,
  })

  const baseThreshold = sceneThreshold
  const calibratedThreshold = calibration.threshold
  const chosenThreshold = autoTuneThreshold ? calibratedThreshold : baseThreshold
  if (autoTuneThreshold && chosenThreshold !== baseThreshold) {
    warnings.push(`Auto-tuned scene threshold from ${baseThreshold} to ${chosenThreshold}`)
  }

  const segments = buildSegments(videoInfo.durationSeconds, workers)
  const detectStartedAt = Date.now()
  let effectiveThreshold = chosenThreshold
  let timestamps = await detectSceneTimestamps({
    ffmpegPath,
    inputPath,
    threshold: effectiveThreshold,
    timeoutMs,
    segments,
    workers,
    onSegmentProgress,
  })
  logSlidesTiming(
    `scene detection base (threshold=${effectiveThreshold}, segments=${segments.length})`,
    detectStartedAt
  )

  if (timestamps.length === 0) {
    const fallbackThreshold = Math.max(0.05, roundThreshold(effectiveThreshold * 0.5))
    if (fallbackThreshold !== effectiveThreshold) {
      const retryStartedAt = Date.now()
      timestamps = await detectSceneTimestamps({
        ffmpegPath,
        inputPath,
        threshold: fallbackThreshold,
        timeoutMs,
        segments,
        workers,
        onSegmentProgress,
      })
      logSlidesTiming(
        `scene detection retry (threshold=${fallbackThreshold}, segments=${segments.length})`,
        retryStartedAt
      )
      warnings.push(
        `Scene detection retry used lower threshold ${fallbackThreshold} after zero detections`
      )
      if (timestamps.length > 0) {
        effectiveThreshold = fallbackThreshold
      }
    }
  }

  const autoTune: SlideAutoTune = autoTuneThreshold
    ? {
        enabled: true,
        chosenThreshold: timestamps.length > 0 ? effectiveThreshold : baseThreshold,
        confidence: calibration.confidence,
        strategy: 'hash',
      }
    : {
        enabled: false,
        chosenThreshold: baseThreshold,
        confidence: 0,
        strategy: 'none',
      }

  return { timestamps, autoTune, durationSeconds: videoInfo.durationSeconds }
}

async function extractFramesAtTimestamps({
  ffmpegPath,
  inputPath,
  outputDir,
  timestamps,
  durationSeconds,
  timeoutMs,
  workers,
  onProgress,
  onStatus,
  onSlide,
}: {
  ffmpegPath: string
  inputPath: string
  outputDir: string
  timestamps: number[]
  durationSeconds?: number | null
  timeoutMs: number
  workers: number
  onProgress?: ((completed: number, total: number) => void) | null
  onStatus?: ((text: string) => void) | null
  onSlide?: ((slide: SlideImage) => void) | null
}): Promise<SlideImage[]> {
  type FrameStats = { ymin: number | null; ymax: number | null; yavg: number | null }
  type FrameQuality = { brightness: number; contrast: number }

  const FRAME_ADJUST_RANGE_SECONDS = 10
  const FRAME_ADJUST_STEP_SECONDS = 2
  const FRAME_MIN_BRIGHTNESS = 0.24
  const FRAME_MIN_CONTRAST = 0.16

  const clampTimestamp = (value: number) => {
    const upper =
      typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
        ? Math.max(0, durationSeconds - 0.1)
        : Number.POSITIVE_INFINITY
    return clamp(value, 0, upper)
  }

  const parseSignalstats = (line: string, stats: FrameStats): void => {
    if (!line.includes('lavfi.signalstats.')) return
    const match = line.match(/lavfi\.signalstats\.(YMIN|YMAX|YAVG)=(\d+(?:\.\d+)?)/)
    if (!match) return
    const value = Number(match[2])
    if (!Number.isFinite(value)) return
    if (match[1] === 'YMIN') stats.ymin = value
    if (match[1] === 'YMAX') stats.ymax = value
    if (match[1] === 'YAVG') stats.yavg = value
  }

  const toQuality = (stats: FrameStats): FrameQuality | null => {
    if (stats.ymin == null || stats.ymax == null || stats.yavg == null) return null
    const brightness = clamp(stats.yavg / 255, 0, 1)
    const contrast = clamp((stats.ymax - stats.ymin) / 255, 0, 1)
    return { brightness, contrast }
  }

  const scoreQuality = (quality: FrameQuality, deltaSeconds: number) => {
    const penalty = Math.min(1, Math.abs(deltaSeconds) / FRAME_ADJUST_RANGE_SECONDS) * 0.05
    // Prefer brighter frames (dark-but-contrasty thumbnails are still unpleasant).
    return quality.brightness * 0.55 + quality.contrast * 0.45 - penalty
  }

  const extractFrame = async (
    timestamp: number,
    outputPath: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ slide: SlideImage; quality: FrameQuality | null }> => {
    const stats: FrameStats = { ymin: null, ymax: null, yavg: null }
    const effectiveTimeoutMs =
      typeof opts?.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
        ? opts.timeoutMs
        : timeoutMs
    const args = [
      '-hide_banner',
      '-ss',
      String(timestamp),
      '-i',
      inputPath,
      '-vf',
      'signalstats,metadata=print',
      '-vframes',
      '1',
      '-q:v',
      '2',
      '-an',
      '-sn',
      outputPath,
    ]
    await runProcess({
      command: ffmpegPath,
      args,
      timeoutMs: effectiveTimeoutMs,
      errorLabel: 'ffmpeg',
      onStderrLine: (line) => {
        parseSignalstats(line, stats)
      },
    })
    const stat = await fs.stat(outputPath).catch(() => null)
    if (!stat?.isFile() || stat.size === 0) {
      throw new Error(`ffmpeg produced no output frame at ${outputPath}`)
    }
    const quality = toQuality(stats)
    return { slide: { index: 0, timestamp, imagePath: outputPath }, quality }
  }

  const slides: SlideImage[] = []
  const startedAt = Date.now()
  const tasks = timestamps.map((timestamp, index) => async () => {
    const clampedTimestamp = clampTimestamp(timestamp)
    const outputPath = path.join(outputDir, `slide_${String(index + 1).padStart(4, '0')}.png`)
    const extracted = await extractFrame(clampedTimestamp, outputPath)
    const imageVersion = Date.now()
    onSlide?.({ index: index + 1, timestamp, imagePath: outputPath, imageVersion })
    return {
      index: index + 1,
      timestamp,
      imagePath: outputPath,
      quality: extracted.quality,
      imageVersion,
    }
  })
  const results = await runWithConcurrency(tasks, workers, onProgress ?? undefined)
  const ordered = results.filter(Boolean).sort((a, b) => a.index - b.index)

  const fixTasks: Array<() => Promise<void>> = []
  for (const frame of ordered) {
    slides.push({
      index: frame.index,
      timestamp: frame.timestamp,
      imagePath: frame.imagePath,
      imageVersion: frame.imageVersion,
    })
    const quality = frame.quality
    if (!quality) continue
    const shouldPreferBrighterFirstSlide = frame.index === 1 && frame.timestamp < 8
    const needsAdjust =
      quality.brightness < FRAME_MIN_BRIGHTNESS ||
      quality.contrast < FRAME_MIN_CONTRAST ||
      (shouldPreferBrighterFirstSlide && (quality.brightness < 0.58 || quality.contrast < 0.2))
    if (!needsAdjust) continue
    fixTasks.push(async () => {
      const baseTimestamp = clampTimestamp(frame.timestamp)
      const candidateOffsets: number[] = []
      for (
        let offset = FRAME_ADJUST_STEP_SECONDS;
        offset <= FRAME_ADJUST_RANGE_SECONDS;
        offset += FRAME_ADJUST_STEP_SECONDS
      ) {
        candidateOffsets.push(offset, -offset)
      }
      let best = {
        timestamp: baseTimestamp,
        offsetSeconds: 0,
        quality,
        score: scoreQuality(quality, 0),
      }
      let selectedTimestamp = baseTimestamp
      let didReplace = false
      const minImproveDelta = shouldPreferBrighterFirstSlide ? 0.015 : 0.03
      for (const offsetSeconds of candidateOffsets) {
        if (offsetSeconds === 0) continue
        const candidateTimestamp = clampTimestamp(baseTimestamp + offsetSeconds)
        const tempPath = path.join(
          outputDir,
          `slide_${String(frame.index).padStart(4, '0')}_alt.png`
        )
        try {
          const candidate = await extractFrame(candidateTimestamp, tempPath, {
            timeoutMs: Math.min(timeoutMs, 12_000),
          })
          if (!candidate.quality) continue
          const score = scoreQuality(candidate.quality, offsetSeconds)
          if (score > best.score + minImproveDelta) {
            best = {
              timestamp: candidateTimestamp,
              offsetSeconds,
              quality: candidate.quality,
              score,
            }
            try {
              await fs.rename(tempPath, frame.imagePath)
            } catch (err) {
              const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
              if (code === 'EEXIST') {
                await fs.rm(frame.imagePath, { force: true }).catch(() => null)
                await fs.rename(tempPath, frame.imagePath)
              } else {
                throw err
              }
            }
            didReplace = true
            selectedTimestamp = candidateTimestamp
          } else {
            await fs.rm(tempPath, { force: true }).catch(() => null)
          }
        } catch {
          await fs.rm(tempPath, { force: true }).catch(() => null)
        }
      }
      if (!didReplace) return
      const updatedVersion = Date.now()
      const slide = slides[frame.index - 1]
      if (slide) {
        slide.imageVersion = updatedVersion
        slide.timestamp = selectedTimestamp
      }
      if (selectedTimestamp !== frame.timestamp) {
        const offsetSeconds = (selectedTimestamp - frame.timestamp).toFixed(2)
        logSlides(
          `thumbnail adjust slide=${frame.index} ts=${frame.timestamp.toFixed(2)}s -> ${selectedTimestamp.toFixed(2)}s offset=${offsetSeconds}s`
        )
      }
      onSlide?.({
        index: frame.index,
        timestamp: selectedTimestamp,
        imagePath: frame.imagePath,
        imageVersion: updatedVersion,
      })
    })
  }
  if (fixTasks.length > 0) {
    const fixStartedAt = Date.now()
    const THUMB_START = 90
    const THUMB_END = 96
    // Avoid UI "stuck" at a static percent while we do expensive refinement passes.
    onStatus?.(`Slides: improving thumbnails ${THUMB_START}%`)
    logSlides(
      `thumbnail adjust start count=${fixTasks.length} range=±${FRAME_ADJUST_RANGE_SECONDS}s step=${FRAME_ADJUST_STEP_SECONDS}s`
    )
    await runWithConcurrency(fixTasks, Math.min(4, workers), (completed, total) => {
      const ratio = total > 0 ? completed / total : 0
      const percent = Math.round(THUMB_START + ratio * (THUMB_END - THUMB_START))
      onStatus?.(`Slides: improving thumbnails ${percent}%`)
    })
    onStatus?.(`Slides: improving thumbnails ${THUMB_END}%`)
    logSlidesTiming('thumbnail adjust done', fixStartedAt)
  }
  logSlidesTiming(`extract frame loop (count=${timestamps.length}, workers=${workers})`, startedAt)
  return slides
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

function buildCalibrationSampleTimestamps(
  durationSeconds: number | null,
  sampleCount: number
): number[] {
  if (!durationSeconds || durationSeconds <= 0) return [0]
  const clamped = Math.max(3, Math.min(12, Math.round(sampleCount)))
  const startRatio = 0.05
  const endRatio = 0.95
  if (clamped === 1) {
    return [clamp(durationSeconds * 0.5, 0, durationSeconds - 0.1)]
  }
  const step = (endRatio - startRatio) / (clamped - 1)
  const points: number[] = []
  for (let i = 0; i < clamped; i += 1) {
    const ratio = startRatio + step * i
    points.push(clamp(durationSeconds * ratio, 0, durationSeconds - 0.1))
  }
  return points
}

function computeDiffStats(values: number[]): {
  median: number
  p75: number
  p90: number
  max: number
} {
  if (values.length === 0) {
    return { median: 0, p75: 0, p90: 0, max: 0 }
  }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p)))] ?? 0
  const median = at((sorted.length - 1) * 0.5)
  const p75 = at((sorted.length - 1) * 0.75)
  const p90 = at((sorted.length - 1) * 0.9)
  const max = sorted[sorted.length - 1] ?? 0
  return { median, p75, p90, max }
}

function roundThreshold(value: number): number {
  return Math.round(value * 100) / 100
}

async function calibrateSceneThreshold({
  ffmpegPath,
  inputPath,
  durationSeconds,
  sampleCount,
  timeoutMs,
}: {
  ffmpegPath: string
  inputPath: string
  durationSeconds: number | null
  sampleCount: number
  timeoutMs: number
}): Promise<{ threshold: number; confidence: number }> {
  const timestamps = buildCalibrationSampleTimestamps(durationSeconds, sampleCount)
  if (timestamps.length < 2) {
    return { threshold: 0.2, confidence: 0 }
  }

  const hashes: Uint8Array[] = []
  for (const timestamp of timestamps) {
    const hash = await hashFrameAtTimestamp({
      ffmpegPath,
      inputPath,
      timestamp,
      timeoutMs,
    })
    if (hash) hashes.push(hash)
  }

  const diffs: number[] = []
  for (let i = 1; i < hashes.length; i += 1) {
    const diff = computeHashDistanceRatio(hashes[i - 1], hashes[i])
    diffs.push(diff)
  }

  const stats = computeDiffStats(diffs)
  const scaledMedian = stats.median * 0.15
  const scaledP75 = stats.p75 * 0.2
  const scaledP90 = stats.p90 * 0.25
  let threshold = roundThreshold(Math.max(scaledMedian, scaledP75, scaledP90))
  if (stats.p75 >= 0.12) {
    threshold = Math.min(threshold, 0.05)
  } else if (stats.p90 < 0.05) {
    threshold = 0.05
  }
  threshold = clamp(threshold, 0.05, 0.3)
  const confidence =
    diffs.length >= 2 ? clamp(stats.p75 / 0.25, 0, 1) : clamp(stats.max / 0.25, 0, 1)
  logSlides(
    `calibration samples=${timestamps.length} diffs=${diffs.length} median=${stats.median.toFixed(
      3
    )} p75=${stats.p75.toFixed(3)} threshold=${threshold}`
  )
  return { threshold, confidence }
}

function buildSegments(
  durationSeconds: number | null,
  workers: number
): Array<{ start: number; duration: number }> {
  if (!durationSeconds || durationSeconds <= 0 || workers <= 1) {
    return [{ start: 0, duration: durationSeconds ?? 0 }]
  }
  const clampedWorkers = Math.max(1, Math.min(16, Math.round(workers)))
  const segmentCount = Math.min(clampedWorkers, Math.ceil(durationSeconds / 60))
  const segmentDuration = durationSeconds / segmentCount
  const segments: Array<{ start: number; duration: number }> = []
  for (let i = 0; i < segmentCount; i += 1) {
    const start = i * segmentDuration
    const remaining = durationSeconds - start
    const duration = i === segmentCount - 1 ? remaining : segmentDuration
    segments.push({ start, duration })
  }
  return segments
}

async function detectSceneTimestamps({
  ffmpegPath,
  inputPath,
  threshold,
  timeoutMs,
  segments,
  workers,
  onSegmentProgress,
}: {
  ffmpegPath: string
  inputPath: string
  threshold: number
  timeoutMs: number
  segments?: Array<{ start: number; duration: number }>
  workers?: number
  onSegmentProgress?: ((completed: number, total: number) => void) | null
}): Promise<number[]> {
  const filter = `select='gt(scene,${threshold})',showinfo`
  const defaultSegments = [{ start: 0, duration: 0 }]
  const usedSegments = segments && segments.length > 0 ? segments : defaultSegments
  const concurrency = workers && workers > 0 ? workers : 1

  const tasks = usedSegments.map((segment) => async () => {
    const args = [
      '-hide_banner',
      ...(segment.duration > 0
        ? ['-ss', String(segment.start), '-t', String(segment.duration)]
        : []),
      '-i',
      inputPath,
      '-vf',
      filter,
      '-fps_mode',
      'vfr',
      '-an',
      '-sn',
      '-f',
      'null',
      '-',
    ]
    const timestamps: number[] = []
    await runProcess({
      command: ffmpegPath,
      args,
      timeoutMs: Math.max(timeoutMs, FFMPEG_TIMEOUT_FALLBACK_MS),
      errorLabel: 'ffmpeg',
      onStderrLine: (line) => {
        const ts = parseShowinfoTimestamp(line)
        if (ts != null) timestamps.push(ts + segment.start)
      },
    })
    return timestamps
  })

  const results = await runWithConcurrency(tasks, concurrency, onSegmentProgress ?? undefined)
  const merged = results.flat()
  merged.sort((a, b) => a - b)
  return merged
}

async function hashFrameAtTimestamp({
  ffmpegPath,
  inputPath,
  timestamp,
  timeoutMs,
}: {
  ffmpegPath: string
  inputPath: string
  timestamp: number
  timeoutMs: number
}): Promise<Uint8Array | null> {
  const filter = 'scale=32:32,format=gray'
  const args = [
    '-hide_banner',
    '-ss',
    String(timestamp),
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-vf',
    filter,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    '-',
  ]
  try {
    const buffer = await runProcessCaptureBuffer({
      command: ffmpegPath,
      args,
      timeoutMs,
      errorLabel: 'ffmpeg',
    })
    if (buffer.length < 1024) return null
    const bytes = buffer.subarray(0, 1024)
    return buildAverageHash(bytes)
  } catch {
    return null
  }
}

function buildAverageHash(pixels: Uint8Array): Uint8Array {
  let sum = 0
  for (const value of pixels) sum += value
  const avg = sum / pixels.length
  const bits = new Uint8Array(pixels.length)
  for (let i = 0; i < pixels.length; i += 1) {
    bits[i] = pixels[i] >= avg ? 1 : 0
  }
  return bits
}

function computeHashDistanceRatio(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length)
  let diff = 0
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) diff += 1
  }
  return len === 0 ? 0 : diff / len
}

async function probeVideoInfo({
  ffprobePath,
  env,
  inputPath,
  timeoutMs,
}: {
  ffprobePath: string | null
  env: Record<string, string | undefined>
  inputPath: string
  timeoutMs: number
}): Promise<{ durationSeconds: number | null; width: number | null; height: number | null }> {
  const probeBin = ffprobePath ?? resolveExecutableInPath('ffprobe', env)
  if (!probeBin) return { durationSeconds: null, width: null, height: null }
  const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', inputPath]
  try {
    const output = await runProcessCapture({
      command: probeBin,
      args,
      timeoutMs: Math.min(timeoutMs, 30_000),
      errorLabel: 'ffprobe',
    })
    const parsed = JSON.parse(output) as {
      streams?: Array<{
        codec_type?: string
        duration?: string | number
        width?: number
        height?: number
      }>
      format?: { duration?: string | number }
    }
    let durationSeconds: number | null = null
    let width: number | null = null
    let height: number | null = null
    for (const stream of parsed.streams ?? []) {
      if (stream.codec_type === 'video') {
        if (width == null && typeof stream.width === 'number') width = stream.width
        if (height == null && typeof stream.height === 'number') height = stream.height
        const duration = Number(stream.duration)
        if (Number.isFinite(duration) && duration > 0) durationSeconds = duration
      }
    }
    if (durationSeconds == null) {
      const formatDuration = Number(parsed.format?.duration)
      if (Number.isFinite(formatDuration) && formatDuration > 0) durationSeconds = formatDuration
    }
    return { durationSeconds, width, height }
  } catch {
    return { durationSeconds: null, width: null, height: null }
  }
}

async function runProcess({
  command,
  args,
  timeoutMs,
  errorLabel,
  onStderrLine,
}: {
  command: string
  args: string[]
  timeoutMs: number
  errorLabel: string
  onStderrLine?: (line: string) => void
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    let stderrBuffer = ''

    const flushLine = (line: string) => {
      if (onStderrLine) onStderrLine(line)
      if (stderr.length < 8192) {
        stderr += line
        if (!line.endsWith('\n')) stderr += '\n'
      }
    }

    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        stderrBuffer += chunk
        const lines = stderrBuffer.split(/\r?\n/)
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) {
          if (line) flushLine(line)
        }
      })
    }

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${errorLabel} timed out`))
    }, timeoutMs)

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (stderrBuffer.trim().length > 0) {
        flushLine(stderrBuffer.trim())
      }
      if (code === 0) {
        resolve()
        return
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : ''
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`))
    })
  })
}

function applyMinDurationFilter(
  slides: SlideImage[],
  minDurationSeconds: number,
  warnings: string[]
): SlideImage[] {
  if (minDurationSeconds <= 0) return slides
  const filtered: SlideImage[] = []
  let lastTimestamp = -Infinity
  for (const slide of slides) {
    if (slide.timestamp - lastTimestamp >= minDurationSeconds) {
      filtered.push(slide)
      lastTimestamp = slide.timestamp
    } else {
      void fs.rm(slide.imagePath, { force: true }).catch(() => {})
    }
  }
  if (filtered.length < slides.length) {
    warnings.push(`Filtered ${slides.length - filtered.length} slides by min duration`)
  }
  return filtered.map((slide, index) => ({ ...slide, index: index + 1 }))
}

function mergeTimestamps(
  sceneTimestamps: number[],
  intervalTimestamps: number[],
  minDurationSeconds: number
): number[] {
  const merged = [...sceneTimestamps, ...intervalTimestamps].filter((value) =>
    Number.isFinite(value)
  )
  merged.sort((a, b) => a - b)
  if (merged.length === 0) return []
  const result: number[] = []
  const minGap = Math.max(0.1, minDurationSeconds * 0.5)
  for (const ts of merged) {
    if (result.length === 0 || ts - result[result.length - 1] >= minGap) {
      result.push(ts)
    }
  }
  return result
}

function filterTimestampsByMinDuration(timestamps: number[], minDurationSeconds: number): number[] {
  if (minDurationSeconds <= 0) return timestamps.slice()
  const sorted = timestamps
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  const filtered: number[] = []
  let lastTimestamp = -Infinity
  for (const ts of sorted) {
    if (ts - lastTimestamp >= minDurationSeconds) {
      filtered.push(ts)
      lastTimestamp = ts
    }
  }
  return filtered
}

function selectTimestampTargets({
  targets,
  sceneTimestamps,
  minDurationSeconds,
  intervalSeconds,
}: {
  targets: number[]
  sceneTimestamps: number[]
  minDurationSeconds: number
  intervalSeconds: number
}): number[] {
  const targetList = targets
    .filter((value) => Number.isFinite(value))
    .slice()
    .sort((a, b) => a - b)
  if (targetList.length === 0) return []

  const sceneList = filterTimestampsByMinDuration(
    sceneTimestamps,
    Math.max(0.1, minDurationSeconds * 0.25)
  )
  const windowSeconds = Math.max(2, Math.min(10, intervalSeconds * 0.35))

  const picked: number[] = []
  let lastPicked = -Infinity
  let sceneIndex = 0
  for (const target of targetList) {
    while (sceneIndex < sceneList.length && sceneList[sceneIndex] < target - windowSeconds) {
      sceneIndex += 1
    }

    let best: number | null = null
    let bestDiff = Number.POSITIVE_INFINITY
    for (let idx = sceneIndex; idx < sceneList.length; idx += 1) {
      const candidate = sceneList[idx]
      if (candidate > target + windowSeconds) break
      const diff = Math.abs(candidate - target)
      if (diff < bestDiff) {
        best = candidate
        bestDiff = diff
      }
    }

    const candidate = best ?? target
    const chosen = candidate - lastPicked >= minDurationSeconds ? candidate : target
    picked.push(chosen)
    lastPicked = chosen
  }

  return picked
}

function buildIntervalTimestamps({
  durationSeconds,
  minDurationSeconds,
  maxSlides,
}: {
  durationSeconds: number | null
  minDurationSeconds: number
  maxSlides: number
}): { timestamps: number[]; intervalSeconds: number } | null {
  if (!durationSeconds || durationSeconds <= 0) return null
  const maxCount = Math.max(1, Math.floor(maxSlides))
  const targetCount = Math.min(maxCount, Math.max(3, Math.round(durationSeconds / 120)))
  const intervalSeconds = Math.max(minDurationSeconds, durationSeconds / targetCount)
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) return null
  const timestamps: number[] = []
  for (let t = 0; t < durationSeconds; t += intervalSeconds) {
    timestamps.push(t)
  }
  return { timestamps, intervalSeconds }
}

async function runProcessCapture({
  command,
  args,
  timeoutMs,
  errorLabel,
}: {
  command: string
  args: string[]
  timeoutMs: number
  errorLabel: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${errorLabel} timed out`))
    }, timeoutMs)

    if (proc.stdout) {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        if (stderr.length < 8192) {
          stderr += chunk
        }
      })
    }

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : ''
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`))
    })
  })
}

async function runProcessCaptureBuffer({
  command,
  args,
  timeoutMs,
  errorLabel,
}: {
  command: string
  args: string[]
  timeoutMs: number
  errorLabel: string
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error(`${errorLabel} timed out`))
    }, timeoutMs)

    if (proc.stdout) {
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk)
      })
    }
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        if (stderr.length < 8192) {
          stderr += chunk
        }
      })
    }

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(Buffer.concat(chunks))
        return
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : ''
      reject(new Error(`${errorLabel} exited with code ${code}${suffix}`))
    })
  })
}

function applyMaxSlidesFilter(
  slides: SlideImage[],
  maxSlides: number,
  warnings: string[]
): SlideImage[] {
  if (maxSlides <= 0 || slides.length <= maxSlides) return slides
  const kept = slides.slice(0, maxSlides)
  const removed = slides.slice(maxSlides)
  for (const slide of removed) {
    if (slide.imagePath) {
      void fs.rm(slide.imagePath, { force: true }).catch(() => {})
    }
  }
  warnings.push(`Trimmed slides to max ${maxSlides}`)
  return kept.map((slide, index) => ({ ...slide, index: index + 1 }))
}

async function renameSlidesWithTimestamps(
  slides: SlideImage[],
  slidesDir: string
): Promise<SlideImage[]> {
  const renamed: SlideImage[] = []
  for (const slide of slides) {
    const timestampLabel = slide.timestamp.toFixed(2)
    const filename = `slide_${slide.index.toString().padStart(4, '0')}_${timestampLabel}s.png`
    const nextPath = path.join(slidesDir, filename)
    if (slide.imagePath !== nextPath) {
      await fs.rename(slide.imagePath, nextPath).catch(async () => {
        await fs.copyFile(slide.imagePath, nextPath)
        await fs.rm(slide.imagePath, { force: true })
      })
    }
    renamed.push({ ...slide, imagePath: nextPath })
  }
  return renamed
}

async function withSlidesLock<T>(
  key: string,
  fn: () => Promise<T>,
  onWait?: (() => void) | null
): Promise<T> {
  const previous = slidesLocks.get(key) ?? null
  if (previous && onWait) onWait()
  let release = () => {}
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  slidesLocks.set(key, current)
  await (previous ?? Promise.resolve())
  try {
    return await fn()
  } finally {
    release()
    if (slidesLocks.get(key) === current) {
      slidesLocks.delete(key)
    }
  }
}

async function readSlidesCacheIfValid({
  slidesDir,
  source,
  settings,
}: {
  slidesDir: string
  source: SlideSource
  settings: SlideSettings
}): Promise<SlideExtractionResult | null> {
  const payloadPath = path.join(slidesDir, 'slides.json')
  let raw: string
  try {
    raw = await fs.readFile(payloadPath, 'utf8')
  } catch {
    return null
  }
  let parsed: SlideExtractionResult
  try {
    parsed = JSON.parse(raw) as SlideExtractionResult
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  if (parsed.sourceId !== source.sourceId) return null
  if (parsed.sourceKind !== source.kind) return null
  if (parsed.sourceUrl !== source.url) return null
  if (parsed.slidesDir !== slidesDir) return null
  if (parsed.sceneThreshold !== settings.sceneThreshold) return null
  if (parsed.maxSlides !== settings.maxSlides) return null
  if (parsed.minSlideDuration !== settings.minDurationSeconds) return null
  if (parsed.ocrRequested !== settings.ocr) return null
  if (!Array.isArray(parsed.slides) || parsed.slides.length === 0) return null
  for (const slide of parsed.slides) {
    if (!slide?.imagePath) return null
    const stat = await fs.stat(slide.imagePath).catch(() => null)
    if (!stat?.isFile()) return null
  }
  return parsed
}

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  workers: number,
  onProgress?: ((completed: number, total: number) => void) | null
): Promise<T[]> {
  if (tasks.length === 0) return []
  const concurrency = Math.max(1, Math.min(16, Math.round(workers)))
  const results: T[] = new Array(tasks.length)
  const total = tasks.length
  let completed = 0
  let nextIndex = 0

  const worker = async () => {
    while (true) {
      const current = nextIndex
      if (current >= tasks.length) return
      nextIndex += 1
      try {
        results[current] = await tasks[current]()
      } finally {
        completed += 1
        onProgress?.(completed, total)
      }
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker())
  await Promise.all(runners)
  return results
}

async function runOcrOnSlides(
  slides: SlideImage[],
  tesseractPath: string,
  workers: number,
  onProgress?: ((completed: number, total: number) => void) | null
): Promise<SlideImage[]> {
  const tasks = slides.map((slide) => async () => {
    try {
      const text = await runTesseract(tesseractPath, slide.imagePath)
      const cleaned = cleanOcrText(text)
      return {
        ...slide,
        ocrText: cleaned,
        ocrConfidence: estimateOcrConfidence(cleaned),
      }
    } catch {
      return { ...slide, ocrText: '', ocrConfidence: 0 }
    }
  })
  const results = await runWithConcurrency(tasks, workers, onProgress ?? undefined)
  return results.sort((a, b) => a.index - b.index)
}

async function runTesseract(tesseractPath: string, imagePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [imagePath, 'stdout', '--oem', '3', '--psm', '6']
    const proc = spawn(tesseractPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('tesseract timed out'))
    }, TESSERACT_TIMEOUT_MS)

    if (proc.stdout) {
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        stdout += chunk
      })
    }
    if (proc.stderr) {
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => {
        if (stderr.length < 8192) {
          stderr += chunk
        }
      })
    }

    proc.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })

    proc.on('close', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve(stdout)
        return
      }
      const suffix = stderr.trim() ? `: ${stderr.trim()}` : ''
      reject(new Error(`tesseract exited with code ${code}${suffix}`))
    })
  })
}

function cleanOcrText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 2)
    .filter((line) => !(line.length > 20 && !line.includes(' ')))
    .filter((line) => /[a-z0-9]/i.test(line))
  return lines.join('\n')
}

function estimateOcrConfidence(text: string): number {
  if (!text) return 0
  const total = text.length
  if (total === 0) return 0
  const alnum = Array.from(text).filter((char) => /[a-z0-9]/i.test(char)).length
  return Math.min(1, alnum / total)
}

async function writeSlidesJson(result: SlideExtractionResult, slidesDir: string): Promise<void> {
  const payload = {
    sourceUrl: result.sourceUrl,
    sourceKind: result.sourceKind,
    sourceId: result.sourceId,
    slidesDir,
    sceneThreshold: result.sceneThreshold,
    autoTuneThreshold: result.autoTuneThreshold,
    autoTune: result.autoTune,
    maxSlides: result.maxSlides,
    minSlideDuration: result.minSlideDuration,
    ocrRequested: result.ocrRequested,
    ocrAvailable: result.ocrAvailable,
    slideCount: result.slides.length,
    warnings: result.warnings,
    slides: result.slides,
  }
  await fs.writeFile(path.join(slidesDir, 'slides.json'), JSON.stringify(payload, null, 2), 'utf8')
}

function buildDirectSourceId(url: string): string {
  const parsed = (() => {
    try {
      return new URL(url)
    } catch {
      return null
    }
  })()
  const rawName = parsed ? path.basename(parsed.pathname) : 'video'
  const base = rawName.replace(/\.[a-z0-9]+$/i, '').trim() || 'video'
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 8)
  return slug ? `${slug}-${hash}` : `video-${hash}`
}
