import process from 'node:process'

export interface OscProgressOptions {
  label?: string
  write?: (data: string) => void
  env?: NodeJS.ProcessEnv
  isTty?: boolean
  /** When true, emit an indeterminate progress indicator (no percentage). */
  indeterminate?: boolean
}

const OSC = '\u001b]9;4;'
const ST = '\u001b\\'

function sanitizeLabel(label: string): string {
  const withoutEscape = label.split('\u001b').join('')
  const withoutBellAndSt = withoutEscape.replaceAll('\u0007', '').replaceAll('\u009c', '')
  return withoutBellAndSt.replaceAll(']', '').trim()
}

export function supportsOscProgress(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = process.stderr.isTTY
): boolean {
  if (!isTty) {
    return false
  }
  const termProgram = (env.TERM_PROGRAM ?? '').toLowerCase()
  if (termProgram.includes('ghostty')) return true
  if (termProgram.includes('wezterm')) return true
  if (env.WT_SESSION) return true
  return false
}

export function startOscProgress(options: OscProgressOptions = {}): () => void {
  const {
    label = 'Working…',
    write = (text) => process.stderr.write(text),
    indeterminate = false,
  } = options
  if (!supportsOscProgress(options.env, options.isTty)) {
    return () => {}
  }
  const cleanLabel = sanitizeLabel(label)

  // Indeterminate ("busy") progress indicator.
  if (indeterminate) {
    write(`${OSC}3;;${cleanLabel}${ST}`)
    return () => {
      write(`${OSC}0;0;${cleanLabel}${ST}`)
    }
  }

  // Fallback: simple 0% -> 99% timer-based bar (never completes by itself).
  const targetMs = 10 * 60_000
  const target = Math.max(targetMs, 1_000)
  const send = (state: number, percent: number): void => {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    write(`${OSC}${state};${clamped};${cleanLabel}${ST}`)
  }

  const startedAt = Date.now()
  send(1, 0)
  const timer = setInterval(() => {
    const elapsed = Date.now() - startedAt
    const percent = Math.min(99, (elapsed / target) * 100)
    send(1, percent)
  }, 900)
  timer.unref?.()

  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    send(0, 0)
  }
}
