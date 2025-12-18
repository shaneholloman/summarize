import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

function noopStream() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
}

function createFailingStream(): AsyncIterable<string> {
  const err = new Error("'file part media type application/pdf' functionality not supported.")
  ;(err as unknown as { name?: string }).name = 'UnsupportedFunctionalityError'
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          throw err
        },
      }
    },
  }
}

const streamTextMock = vi.fn(() => ({
  textStream: createFailingStream(),
  totalUsage: Promise.resolve({
    promptTokens: 10,
    completionTokens: 0,
    totalTokens: 10,
  }),
}))

const createXaiMock = vi.fn(() => {
  return (_modelId: string) => ({})
})

vi.mock('ai', () => ({
  streamText: streamTextMock,
}))

vi.mock('@ai-sdk/xai', () => ({
  createXai: createXaiMock,
}))

describe('cli asset inputs (unsupported by provider)', () => {
  it('prints a friendly error when a provider rejects PDF attachments', async () => {
    streamTextMock.mockClear()

    const root = mkdtempSync(join(tmpdir(), 'summarize-asset-unsupported-'))
    const pdfPath = join(root, 'test.pdf')
    writeFileSync(pdfPath, Buffer.from('%PDF-1.7\n%âãÏÓ\n1 0 obj\n<<>>\nendobj\n', 'utf8'))

    const run = () =>
      runCli(
        ['--model', 'xai/grok-4-fast-non-reasoning', '--timeout', '2s', '--stream', 'on', pdfPath],
        {
          env: { XAI_API_KEY: 'test' },
          fetch: vi.fn(async () => {
            throw new Error('unexpected fetch')
          }) as unknown as typeof fetch,
          stdout: noopStream(),
          stderr: noopStream(),
        }
      )

    await expect(run()).rejects.toThrow(/does not support attaching files/i)
    await expect(run()).rejects.toThrow(/application\/pdf/i)
    expect(streamTextMock).toHaveBeenCalledTimes(0)
  })
})
