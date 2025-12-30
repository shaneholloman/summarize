import { describe, expect, it } from 'vitest'

import {
  createDaemonRecovery,
  isDaemonUnreachableError,
} from '../apps/chrome-extension/src/lib/daemon-recovery.js'

describe('chrome/daemon-recovery', () => {
  it('retries once after daemon recovers', () => {
    const recovery = createDaemonRecovery()
    recovery.recordFailure('https://example.com')

    expect(
      recovery.maybeRecover({
        isReady: false,
        currentUrlMatches: true,
        isIdle: true,
      })
    ).toBe(false)
    expect(recovery.getPendingUrl()).toBe('https://example.com')

    expect(
      recovery.maybeRecover({
        isReady: true,
        currentUrlMatches: true,
        isIdle: true,
      })
    ).toBe(true)
    expect(recovery.getPendingUrl()).toBeNull()

    expect(
      recovery.maybeRecover({
        isReady: true,
        currentUrlMatches: true,
        isIdle: true,
      })
    ).toBe(false)
  })

  it('does not recover while inflight', () => {
    const recovery = createDaemonRecovery()
    recovery.recordFailure('https://example.com')

    expect(
      recovery.maybeRecover({
        isReady: true,
        currentUrlMatches: true,
        isIdle: false,
      })
    ).toBe(false)
    expect(recovery.getPendingUrl()).toBe('https://example.com')
  })

  it('keeps pending when status updates without recovery check', () => {
    const recovery = createDaemonRecovery()
    recovery.recordFailure('https://example.com')
    recovery.updateStatus(true)

    expect(
      recovery.maybeRecover({
        isReady: true,
        currentUrlMatches: true,
        isIdle: true,
      })
    ).toBe(false)
    expect(recovery.getPendingUrl()).toBe('https://example.com')
  })

  it('clears pending when URL changes', () => {
    const recovery = createDaemonRecovery()
    recovery.recordFailure('https://example.com')

    expect(
      recovery.maybeRecover({
        isReady: true,
        currentUrlMatches: false,
        isIdle: true,
      })
    ).toBe(false)
    expect(recovery.getPendingUrl()).toBeNull()
  })

  it('detects daemon unreachable errors', () => {
    expect(isDaemonUnreachableError(new Error('Failed to fetch'))).toBe(true)
    expect(
      isDaemonUnreachableError(new Error('NetworkError when attempting to fetch resource.'))
    ).toBe(true)
    expect(isDaemonUnreachableError(new Error('ECONNREFUSED 127.0.0.1'))).toBe(true)
    expect(isDaemonUnreachableError(new Error('401 Unauthorized'))).toBe(false)
  })
})
