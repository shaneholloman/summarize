import fs from 'node:fs'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'

import { runCli } from '../src/run.js'

function collectStream() {
  let text = ''
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString()
      callback()
    },
  })
  return { stream, getText: () => text }
}

describe('cli --version', () => {
  it('prints package.json version', async () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string }
    const stdout = collectStream()
    const stderr = collectStream()

    await runCli(['--version'], {
      env: {},
      fetch: globalThis.fetch.bind(globalThis),
      stdout: stdout.stream,
      stderr: stderr.stream,
    })

    expect(stdout.getText()).toContain(pkg.version)
    expect(stderr.getText()).toBe('')
  })
})
