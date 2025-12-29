import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CacheState } from '../src/cache.js'
import { createDaemonUrlFlowContext } from '../src/daemon/flow-context.js'

describe('daemon/flow-context extractOnly', () => {
  it('sets extractMode when extractOnly is true', () => {
    const root = mkdtempSync(join(tmpdir(), 'summarize-daemon-extract-only-'))
    const cache: CacheState = {
      mode: 'bypass',
      store: null,
      ttlMs: 0,
      maxBytes: 0,
      path: null,
    }

    const ctx = createDaemonUrlFlowContext({
      env: { HOME: root, OPENAI_API_KEY: 'test' },
      fetchImpl: fetch,
      cache,
      modelOverride: 'openai/gpt-5-mini',
      promptOverride: null,
      lengthRaw: 'xl',
      languageRaw: 'auto',
      maxExtractCharacters: 5000,
      extractOnly: true,
      runStartedAtMs: Date.now(),
      stdoutSink: { writeChunk: () => {} },
    })

    expect(ctx.flags.extractMode).toBe(true)
  })
})
