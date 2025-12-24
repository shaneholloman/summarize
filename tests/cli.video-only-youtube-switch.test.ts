import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

function collectStream({ isTTY }: { isTTY: boolean }) {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  ;(stream as unknown as { isTTY?: boolean }).isTTY = isTTY
  ;(stream as unknown as { columns?: number }).columns = 120
  return { stream, getText: () => text }
}

// Deterministic spinner: start writes once, updates are no-ops.
vi.mock('ora', () => {
  const ora = (opts: { text: string; stream: NodeJS.WritableStream }) => {
    const spinner: any = {
      isSpinning: true,
      text: opts.text,
      stop() {
        spinner.isSpinning = false
      },
      clear() {},
      start() {
        opts.stream.write(`- ${spinner.text}`)
        return spinner
      },
      setText(text: string) {
        spinner.text = text
      },
    }
    return spinner
  }
  return { default: ora }
})

const mocks = vi.hoisted(() => {
  const fetchLinkContent = vi.fn(async (url: string) => {
    if (url === 'https://example.com/video-only') {
      return {
        url,
        title: 'Video Only',
        description: null,
        siteName: 'Example',
        content: 'placeholder',
        truncated: false,
        totalCharacters: 11,
        wordCount: 1,
        transcriptCharacters: null,
        transcriptLines: null,
        transcriptWordCount: null,
        transcriptSource: null,
        transcriptMetadata: null,
        transcriptionProvider: null,
        mediaDurationSeconds: null,
        video: { kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
        isVideoOnly: true,
        diagnostics: {
          strategy: 'html',
          cacheMode: 'default',
          cacheStatus: 'miss',
          firecrawl: { attempted: false, used: false, notes: null },
          markdown: { requested: false, used: false, provider: null, notes: null },
          transcript: {
            cacheMode: 'default',
            cacheStatus: 'miss',
            textProvided: false,
            provider: null,
            attemptedProviders: [],
            notes: null,
          },
        },
      }
    }

    if (url === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ') {
      return {
        url,
        title: 'YouTube',
        description: null,
        siteName: 'YouTube',
        content: 'Transcript: hello',
        truncated: false,
        totalCharacters: 17,
        wordCount: 2,
        transcriptCharacters: 11,
        transcriptLines: null,
        transcriptWordCount: 1,
        transcriptSource: 'youtube',
        transcriptMetadata: null,
        transcriptionProvider: null,
        mediaDurationSeconds: null,
        video: null,
        isVideoOnly: false,
        diagnostics: {
          strategy: 'youtube',
          cacheMode: 'default',
          cacheStatus: 'miss',
          firecrawl: { attempted: false, used: false, notes: null },
          markdown: { requested: false, used: false, provider: null, notes: null },
          transcript: {
            cacheMode: 'default',
            cacheStatus: 'miss',
            textProvided: true,
            provider: 'youtube',
            attemptedProviders: ['youtube'],
            notes: null,
          },
        },
      }
    }

    throw new Error(`Unexpected url: ${url}`)
  })

  const createLinkPreviewClient = vi.fn(() => ({ fetchLinkContent }))

  return { createLinkPreviewClient, fetchLinkContent }
})

vi.mock('../src/content/index.js', () => ({
  createLinkPreviewClient: mocks.createLinkPreviewClient,
}))

import { runCli } from '../src/run.js'

describe('cli video-only pages', () => {
  it('switches to YouTube transcript when a page is video-only', async () => {
    const stdout = collectStream({ isTTY: false })
    const stderr = collectStream({ isTTY: true })

    await runCli(['--extract', '--metrics', 'off', '--timeout', '2s', 'https://example.com/video-only'], {
      env: {},
      fetch: vi.fn() as unknown as typeof fetch,
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(mocks.fetchLinkContent).toHaveBeenCalledTimes(2)
    expect(mocks.fetchLinkContent.mock.calls[0]?.[0]).toBe('https://example.com/video-only')
    expect(mocks.fetchLinkContent.mock.calls[1]?.[0]).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    expect(stdout.getText()).toContain('Transcript: hello')
  })
})
