import type { TranscriptSource } from '../link-preview/types.js'

/** Public shape returned by transcript cache implementations. */
export interface TranscriptCacheGetResult {
  content: string | null
  source: TranscriptSource | null
  expired: boolean
  metadata?: Record<string, unknown> | null
}

/** Public write arguments for transcript cache implementations. */
export interface TranscriptCacheSetArgs {
  url: string
  service: string
  resourceKey: string | null
  content: string | null
  source: TranscriptSource | null
  ttlMs: number
  metadata?: Record<string, unknown> | null
  fileMtime?: number | null
}

/** Public interface for pluggable transcript caches (CLI, daemon, apps). */
export interface TranscriptCache {
  get(args: { url: string; fileMtime?: number | null }): Promise<TranscriptCacheGetResult | null>
  set(args: TranscriptCacheSetArgs): Promise<void>
}

export type MediaCacheEntry = {
  url: string
  filePath: string
  sizeBytes: number | null
  sha256: string | null
  mediaType: string | null
  filename: string | null
  createdAtMs: number
  lastAccessAtMs: number
  expiresAtMs: number | null
}

export interface MediaCache {
  get(args: { url: string }): Promise<MediaCacheEntry | null>
  put(args: {
    url: string
    filePath: string
    mediaType?: string | null
    filename?: string | null
  }): Promise<MediaCacheEntry | null>
}
