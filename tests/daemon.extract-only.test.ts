import { createServer } from 'node:net'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { runDaemonServer } from '../src/daemon/server.js'

const findFreePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve port')))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })

describe('daemon /v1/summarize extractOnly', () => {
  it('rejects extractOnly for page mode', async () => {
    const home = mkdtempSync(join(tmpdir(), 'summarize-daemon-extract-only-'))
    const port = await findFreePort()
    const token = 'test-token-123'

    const abortController = new AbortController()
    let resolveReady: (() => void) | null = null
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })

    const serverPromise = runDaemonServer({
      env: { HOME: home },
      fetchImpl: fetch,
      config: { token, port, version: 1, installedAt: new Date().toISOString() },
      port,
      signal: abortController.signal,
      onListening: () => resolveReady?.(),
    })

    await ready

    const res = await fetch(`http://127.0.0.1:${port}/v1/summarize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        url: 'https://example.com',
        mode: 'page',
        extractOnly: true,
      }),
    })

    const json = (await res.json()) as { error?: string }
    expect(res.status).toBe(400)
    expect(json.error).toMatch(/extractOnly requires mode=url/i)

    abortController.abort()
    await serverPromise
  })
})
