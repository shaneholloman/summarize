import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { loadLocalAsset, loadRemoteAsset } from '../src/content/asset.js'

describe('asset loaders', () => {
  it('rejects non-files and oversize local files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-'))
    const dirPath = join(root, 'dir')
    mkdirSync(dirPath, { recursive: true })
    await expect(loadLocalAsset({ filePath: dirPath })).rejects.toThrow(/Not a file/i)

    const bigPath = join(root, 'big.bin')
    writeFileSync(bigPath, Buffer.alloc(10, 0))
    await expect(loadLocalAsset({ filePath: bigPath, maxBytes: 5 })).rejects.toThrow(
      /File too large/i
    )
  })

  it('rejects remote non-200 and oversize downloads', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        fetchImpl: async () => new Response('nope', { status: 500 }),
      })
    ).rejects.toThrow(/Download failed/i)

    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        maxBytes: 10,
        fetchImpl: async () =>
          new Response(new Uint8Array(1), { status: 200, headers: { 'content-length': '999' } }),
      })
    ).rejects.toThrow(/Remote file too large/i)

    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        maxBytes: 10,
        fetchImpl: async () => new Response(Buffer.alloc(11), { status: 200 }),
      })
    ).rejects.toThrow(/Remote file too large/i)
  })

  it('detects HTML masquerading as a file', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/file.bin',
        timeoutMs: 2000,
        fetchImpl: async () =>
          new Response('<html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          }),
      })
    ).rejects.toThrow(/appears to be a website/i)
  })

  it('creates image parts when media type is image/*', async () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-img-'))
    const jpgPath = join(root, 'test.jpg')
    // Minimal JPEG header.
    writeFileSync(jpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00]))

    const loaded = await loadLocalAsset({ filePath: jpgPath, maxBytes: 1024 })
    expect(loaded.attachment.mediaType).toBe('image/jpeg')
    expect(loaded.attachment.part.type).toBe('image')
  })

  it('detects HTML based on bytes when content-type is missing', async () => {
    await expect(
      loadRemoteAsset({
        url: 'https://example.com/',
        timeoutMs: 2000,
        fetchImpl: async () =>
          new Response('<!doctype html><html><body>hi</body></html>', {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          }),
      })
    ).rejects.toThrow(/appears to be a website/i)
  })
})
