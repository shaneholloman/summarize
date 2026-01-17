import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { SlideSettings } from './settings.js'
import type { SlideExtractionResult, SlideSource } from './types.js'

const normalizePath = (value: string) => path.resolve(value)

export function resolveSlidesDir(outputDir: string, sourceId: string): string {
  return path.join(outputDir, sourceId)
}

export function buildSlidesDirId(slidesDir: string): string {
  return createHash('sha1').update(normalizePath(slidesDir)).digest('hex').slice(0, 8)
}

const isPathUnderRoot = (root: string, candidate: string): boolean => {
  const rel = path.relative(root, candidate)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function resolveSlideImagePath(slidesDir: string, imagePath: string): string | null {
  if (!imagePath) return null
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.join(slidesDir, imagePath)
  const normalizedSlidesDir = normalizePath(slidesDir)
  const normalizedResolved = normalizePath(resolved)
  if (!isPathUnderRoot(normalizedSlidesDir, normalizedResolved)) return null
  return normalizedResolved
}

export function serializeSlideImagePath(slidesDir: string, imagePath: string): string {
  const resolved = path.isAbsolute(imagePath) ? imagePath : path.join(slidesDir, imagePath)
  const normalizedSlidesDir = normalizePath(slidesDir)
  const normalizedResolved = normalizePath(resolved)
  const rel = path.relative(normalizedSlidesDir, normalizedResolved)
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    return rel
  }
  return imagePath
}

export async function validateSlidesCache({
  cached,
  source,
  settings,
}: {
  cached: SlideExtractionResult
  source: SlideSource
  settings: SlideSettings
}): Promise<SlideExtractionResult | null> {
  if (!cached || typeof cached !== 'object') return null
  if (cached.sourceId !== source.sourceId) return null
  if (cached.sourceKind !== source.kind) return null
  if (cached.sourceUrl !== source.url) return null

  const expectedSlidesDir = resolveSlidesDir(settings.outputDir, source.sourceId)
  const normalizedExpectedDir = normalizePath(expectedSlidesDir)
  const normalizedOutputDir = normalizePath(settings.outputDir)
  if (!isPathUnderRoot(normalizedOutputDir, normalizedExpectedDir)) return null
  if (!cached.slidesDir || normalizePath(cached.slidesDir) !== normalizedExpectedDir) {
    return null
  }
  const expectedDirId = buildSlidesDirId(normalizedExpectedDir)
  if (cached.slidesDirId && cached.slidesDirId !== expectedDirId) return null

  if (cached.sceneThreshold !== settings.sceneThreshold) return null
  if (cached.maxSlides !== settings.maxSlides) return null
  if (cached.minSlideDuration !== settings.minDurationSeconds) return null
  if (cached.ocrRequested !== settings.ocr) return null
  if (!Array.isArray(cached.slides) || cached.slides.length === 0) return null

  const slides = []
  try {
    const dirStat = await fs.stat(normalizedExpectedDir)
    if (!dirStat?.isDirectory()) return null
  } catch {
    return null
  }

  for (const slide of cached.slides) {
    if (!slide?.imagePath) return null
    const resolved = resolveSlideImagePath(normalizedExpectedDir, slide.imagePath)
    if (!resolved) return null
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat?.isFile()) return null
    slides.push({ ...slide, imagePath: resolved })
  }

  return {
    ...cached,
    slidesDir: normalizedExpectedDir,
    slidesDirId: cached.slidesDirId ?? expectedDirId,
    slides,
  }
}

export async function readSlidesCacheIfValid({
  source,
  settings,
}: {
  source: SlideSource
  settings: SlideSettings
}): Promise<SlideExtractionResult | null> {
  const slidesDir = resolveSlidesDir(settings.outputDir, source.sourceId)
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
  return await validateSlidesCache({ cached: parsed, source, settings })
}
