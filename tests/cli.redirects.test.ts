import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../src/run.js'

describe('cli redirect handling', () => {
  it('uses the final URL after redirects for extraction output', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-cli-redirects-'))
    const html = '<!doctype html><html><head><title>Ok</title></head><body><p>Hi</p></body></html>'

    const fetchMock = vi.fn(async () => {
      const response = new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
      Object.defineProperty(response, 'url', {
        value: 'https://summarize.sh/',
        configurable: true,
      })
      return response
    })

    let stdoutText = ''
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutText += chunk.toString()
        callback()
      },
    })

    await runCli(
      ['--json', '--extract', '--format', 'text', '--timeout', '2s', 'https://t.co/abc'],
      {
        env: { HOME: home },
        fetch: fetchMock as unknown as typeof fetch,
        stdout,
        stderr: new Writable({
          write(_chunk, _encoding, callback) {
            callback()
          },
        }),
      }
    )

    const parsed = JSON.parse(stdoutText) as { extracted: { url: string } }
    expect(parsed.extracted.url).toBe('https://summarize.sh/')
  })
})
