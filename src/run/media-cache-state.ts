import type { SummarizeConfig } from '../config.js'
import type { MediaCache } from '../content/index.js'
import {
  createMediaCache,
  DEFAULT_MEDIA_CACHE_MAX_MB,
  DEFAULT_MEDIA_CACHE_TTL_DAYS,
  DEFAULT_MEDIA_CACHE_VERIFY,
  type MediaCacheVerifyMode,
  resolveMediaCachePath,
} from '../media-cache.js'

export async function createMediaCacheFromConfig({
  envForRun,
  config,
  noMediaCacheFlag = false,
}: {
  envForRun: Record<string, string | undefined>
  config: SummarizeConfig | null
  noMediaCacheFlag?: boolean
}): Promise<MediaCache | null> {
  const mediaConfig = config?.cache?.media
  const enabled = mediaConfig?.enabled !== false
  if (!enabled || noMediaCacheFlag) return null

  const cachePath = resolveMediaCachePath({
    env: envForRun,
    cachePath: typeof mediaConfig?.path === 'string' ? mediaConfig.path : null,
  })
  if (!cachePath) return null

  const maxMb =
    typeof mediaConfig?.maxMb === 'number' && Number.isFinite(mediaConfig.maxMb)
      ? mediaConfig.maxMb
      : DEFAULT_MEDIA_CACHE_MAX_MB
  const ttlDays =
    typeof mediaConfig?.ttlDays === 'number' && Number.isFinite(mediaConfig.ttlDays)
      ? mediaConfig.ttlDays
      : DEFAULT_MEDIA_CACHE_TTL_DAYS
  const verify =
    typeof mediaConfig?.verify === 'string'
      ? (mediaConfig.verify as MediaCacheVerifyMode)
      : DEFAULT_MEDIA_CACHE_VERIFY
  const maxBytes = Math.max(0, maxMb) * 1024 * 1024
  const ttlMs = Math.max(0, ttlDays) * 24 * 60 * 60 * 1000
  if (maxBytes <= 0) return null

  return await createMediaCache({
    path: cachePath,
    maxBytes,
    ttlMs,
    verify,
  })
}
