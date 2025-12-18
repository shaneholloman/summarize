import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({ text: 'chunk-note' }))
const streamTextMock = vi.fn(() => ({
  textStream: {
    async *[Symbol.asyncIterator]() {
      yield 'FINAL'
    },
  },
  totalUsage: Promise.resolve({ promptTokens: 10, completionTokens: 2, totalTokens: 12 }),
}))

vi.mock('ai', () => ({
  generateText: generateTextMock,
  streamText: streamTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
  }),
}))

describe('cli map-reduce streaming', () => {
  it('streams final merge output to stdout when render=plain', async () => {
    const content = 'A'.repeat(130_000)
    const html =
      '<!doctype html><html><head><title>Big</title></head>' +
      `<body><article><p>${content}</p></article></body></html>`

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') return htmlResponse(html)
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })
    ;(stdout as unknown as { isTTY?: boolean; columns?: number }).isTTY = true
    ;(stdout as unknown as { isTTY?: boolean; columns?: number }).columns = 120

    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        void chunk
        callback()
      },
    })
    ;(stderr as unknown as { isTTY?: boolean }).isTTY = true

    await runCli(
      ['--model', 'openai/gpt-5.2', '--stream', 'on', '--render', 'plain', 'https://example.com'],
      {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      }
    )

    expect(stdoutText).toContain('FINAL')
    expect(streamTextMock).toHaveBeenCalledTimes(1)
    expect(generateTextMock).toHaveBeenCalled()
  })
})
