import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveSlideSettings } from '../src/slides/settings.js'
import type { SlideExtractionResult } from '../src/slides/types.js'
import {
  buildSlidesDirId,
  readSlidesCacheIfValid,
  resolveSlideImagePath,
  resolveSlidesDir,
  serializeSlideImagePath,
  validateSlidesCache,
} from '../src/slides/store.js'

describe('slides store', () => {
  it('serializes relative paths and resolves cached slides', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-slides-store-'))
    const settings = resolveSlideSettings({ slides: true, cwd: root })
    expect(settings).not.toBeNull()
    if (!settings) return

    const source = {
      url: 'https://example.com/video.mp4',
      kind: 'direct' as const,
      sourceId: 'video-abc',
    }
    const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId)
    await fs.mkdir(slidesDir, { recursive: true })
    const imagePath = path.join(slidesDir, 'slide_0001.png')
    await fs.writeFile(imagePath, 'fake')

    const payload: SlideExtractionResult = {
      sourceUrl: source.url,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      slidesDir,
      slidesDirId: buildSlidesDirId(slidesDir),
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      autoTune: { enabled: false, chosenThreshold: settings.sceneThreshold, confidence: 0, strategy: 'none' },
      maxSlides: settings.maxSlides,
      minSlideDuration: settings.minDurationSeconds,
      ocrRequested: settings.ocr,
      ocrAvailable: false,
      slides: [
        {
          index: 1,
          timestamp: 12.3,
          imagePath: serializeSlideImagePath(slidesDir, imagePath),
        },
      ],
      warnings: [],
    }

    await fs.writeFile(path.join(slidesDir, 'slides.json'), JSON.stringify(payload, null, 2), 'utf8')
    const cached = await readSlidesCacheIfValid({ source, settings })
    expect(cached?.slides[0]?.imagePath).toBe(imagePath)
    expect(cached?.slidesDirId).toBe(buildSlidesDirId(slidesDir))
  })

  it('rejects cache outside expected output dir', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-slides-store-'))
    const settings = resolveSlideSettings({ slides: true, cwd: root })
    expect(settings).not.toBeNull()
    if (!settings) return

    const source = {
      url: 'https://example.com/video.mp4',
      kind: 'direct' as const,
      sourceId: 'video-xyz',
    }

    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'summarize-slides-other-'))
    const imagePath = path.join(otherDir, 'slide_0001.png')
    await fs.writeFile(imagePath, 'fake')

    const cached: SlideExtractionResult = {
      sourceUrl: source.url,
      sourceKind: source.kind,
      sourceId: source.sourceId,
      slidesDir: otherDir,
      slidesDirId: buildSlidesDirId(otherDir),
      sceneThreshold: settings.sceneThreshold,
      autoTuneThreshold: settings.autoTuneThreshold,
      autoTune: { enabled: false, chosenThreshold: settings.sceneThreshold, confidence: 0, strategy: 'none' },
      maxSlides: settings.maxSlides,
      minSlideDuration: settings.minDurationSeconds,
      ocrRequested: settings.ocr,
      ocrAvailable: false,
      slides: [{ index: 1, timestamp: 1.2, imagePath }],
      warnings: [],
    }

    const validated = await validateSlidesCache({ cached, source, settings })
    expect(validated).toBeNull()
  })

  it('rejects image paths outside slides dir', () => {
    const slidesDir = '/tmp/summarize-slides'
    const resolved = resolveSlideImagePath(slidesDir, '../escape.png')
    expect(resolved).toBeNull()
  })
})
