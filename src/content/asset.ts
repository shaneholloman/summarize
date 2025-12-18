import { existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FilePart, ImagePart, ModelMessage } from 'ai'
import { fileTypeFromBuffer } from 'file-type'
import mime from 'mime'

export type InputTarget = { kind: 'url'; url: string } | { kind: 'file'; filePath: string }

export type UrlKind = { kind: 'website' } | { kind: 'asset' }

export type AssetAttachment = {
  mediaType: string
  filename: string | null
  part: ImagePart | FilePart
}

const MAX_ASSET_BYTES_DEFAULT = 50 * 1024 * 1024

function normalizeHeaderMediaType(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.split(';')[0]?.trim().toLowerCase() ?? null
}

function isHtmlMediaType(mediaType: string | null): boolean {
  if (!mediaType) return false
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder().decode(bytes.slice(0, 256)).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<head')
}

function isLikelyAssetPathname(pathname: string): boolean {
  const ext = path.extname(pathname).toLowerCase()
  if (!ext) return false
  if (ext === '.html' || ext === '.htm' || ext === '.php' || ext === '.asp' || ext === '.aspx') {
    return false
  }
  return true
}

export function resolveInputTarget(raw: string): InputTarget {
  const normalized = raw.trim()
  if (!normalized) {
    throw new Error('Missing input')
  }

  const asPath = path.resolve(normalized)
  if (existsSync(asPath)) {
    return { kind: 'file', filePath: asPath }
  }

  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`Invalid URL or file path: ${raw}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'file:') {
    const embedded = normalized.lastIndexOf('https://')
    const embeddedHttp = normalized.lastIndexOf('http://')
    const idx = Math.max(embedded, embeddedHttp)
    if (idx >= 0) {
      const candidate = normalized.slice(idx)
      return resolveInputTarget(candidate)
    }
  }

  if (parsed.protocol === 'file:') {
    const filePath = path.resolve(decodeURIComponent(parsed.pathname))
    return { kind: 'file', filePath }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS URLs can be summarized')
  }
  return { kind: 'url', url: normalized }
}

export async function classifyUrl({
  url,
  fetchImpl,
  timeoutMs,
}: {
  url: string
  fetchImpl: typeof fetch
  timeoutMs: number
}): Promise<UrlKind> {
  const parsed = new URL(url)
  if (isLikelyAssetPathname(parsed.pathname)) {
    return { kind: 'asset' }
  }

  void fetchImpl
  void timeoutMs
  return { kind: 'website' }
}

async function detectMediaType({
  bytes,
  headerContentType,
  nameHint,
}: {
  bytes: Uint8Array
  headerContentType: string | null
  nameHint: string | null
}): Promise<string> {
  const sniffed = await fileTypeFromBuffer(bytes)
  if (sniffed?.mime) return sniffed.mime

  const header = normalizeHeaderMediaType(headerContentType)
  if (header && header !== 'application/octet-stream') return header

  if (nameHint) {
    const byExt = mime.getType(nameHint)
    if (typeof byExt === 'string' && byExt.length > 0) return byExt
  }

  return 'application/octet-stream'
}

function buildAttachment({
  bytes,
  mediaType,
  filename,
}: {
  bytes: Uint8Array
  mediaType: string
  filename: string | null
}): AssetAttachment {
  if (mediaType.startsWith('image/')) {
    const part: ImagePart = {
      type: 'image',
      image: bytes,
      mediaType,
    }
    return { mediaType, filename, part }
  }

  const part: FilePart = {
    type: 'file',
    data: bytes,
    filename: filename ?? undefined,
    mediaType,
  }
  return { mediaType, filename, part }
}

export async function loadLocalAsset({
  filePath,
  maxBytes = MAX_ASSET_BYTES_DEFAULT,
}: {
  filePath: string
  maxBytes?: number
}): Promise<{ sourceLabel: string; attachment: AssetAttachment }> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${filePath}`)
  }
  if (stat.size > maxBytes) {
    throw new Error(`File too large (${stat.size} bytes). Limit is ${maxBytes} bytes.`)
  }

  const bytes = new Uint8Array(await fs.readFile(filePath))
  const filename = path.basename(filePath)
  const mediaType = await detectMediaType({ bytes, headerContentType: null, nameHint: filename })
  return {
    sourceLabel: filePath,
    attachment: buildAttachment({ bytes, mediaType, filename }),
  }
}

export async function loadRemoteAsset({
  url,
  fetchImpl,
  timeoutMs,
  maxBytes = MAX_ASSET_BYTES_DEFAULT,
}: {
  url: string
  fetchImpl: typeof fetch
  timeoutMs: number
  maxBytes?: number
}): Promise<{ sourceLabel: string; attachment: AssetAttachment }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status} ${res.statusText}`)
    }

    const contentLength = res.headers.get('content-length')
    if (contentLength) {
      const parsed = Number(contentLength)
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        throw new Error(`Remote file too large (${parsed} bytes). Limit is ${maxBytes} bytes.`)
      }
    }

    const arrayBuffer = await res.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(
        `Remote file too large (${arrayBuffer.byteLength} bytes). Limit is ${maxBytes} bytes.`
      )
    }

    const bytes = new Uint8Array(arrayBuffer)
    const parsedUrl = new URL(url)
    const filename = path.basename(parsedUrl.pathname) || null
    const headerContentType = res.headers.get('content-type')
    const mediaType = await detectMediaType({ bytes, headerContentType, nameHint: filename })

    if (isHtmlMediaType(mediaType) || looksLikeHtml(bytes)) {
      throw new Error('URL appears to be a website (HTML), not a file')
    }

    return {
      sourceLabel: url,
      attachment: buildAttachment({ bytes, mediaType, filename }),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function buildAssetPromptMessages({
  promptText,
  attachment,
}: {
  promptText: string
  attachment: AssetAttachment
}): Array<ModelMessage> {
  return [
    {
      role: 'user',
      content: [{ type: 'text', text: promptText }, attachment.part],
    },
  ]
}
