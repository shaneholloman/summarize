import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

const htmlResponse = (html: string, status = 200) =>
  new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })

const generateTextMock = vi.fn(async () => ({
  text: '   ',
}))

vi.mock('ai', () => ({
  generateText: generateTextMock,
}))

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(({ apiKey }: { apiKey: string }) => {
    return (modelId: string) => ({ provider: 'openai', modelId, apiKey })
  }),
}))

describe('cli empty summary handling', () => {
  it('throws when model returns only whitespace', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.url
      if (url === 'https://example.com') {
        return htmlResponse(
          '<!doctype html><html><body><article><p>Hello</p></article></body></html>'
        )
      }
      throw new Error(`Unexpected fetch call: ${url}`)
    })

    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        void chunk
        callback()
      },
    })
    const stderr = new Writable({
      write(chunk, _encoding, callback) {
        void chunk
        callback()
      },
    })

    await expect(
      runCli(['--model', 'openai/gpt-5.2', '--timeout', '10s', 'https://example.com'], {
        env: { OPENAI_API_KEY: 'test' },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr,
      })
    ).rejects.toThrow(/empty summary/i)
  })
})
