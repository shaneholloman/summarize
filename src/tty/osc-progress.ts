import {
  OSC_PROGRESS_BEL,
  OSC_PROGRESS_PREFIX,
  OSC_PROGRESS_ST,
  sanitizeLabel,
  startOscProgress as startOscProgressImpl,
  supportsOscProgress as supportsOscProgressImpl,
} from 'osc-progress'

export type { OscProgressOptions } from 'osc-progress'

export function startOscProgress(options: import('osc-progress').OscProgressOptions) {
  return startOscProgressImpl(options)
}

export function supportsOscProgress(env: Record<string, string | undefined>, isTty: boolean) {
  return supportsOscProgressImpl(env, isTty)
}

export type OscProgressController = {
  setIndeterminate: (label: string) => void
  setPercent: (label: string, percent: number) => void
  clear: () => void
}

export function createOscProgressController(
  options: import('osc-progress').OscProgressOptions
): OscProgressController {
  const env = options.env
  const isTty = options.isTty
  const write = options.write ?? ((text) => process.stderr.write(text))
  const terminator = options.terminator ?? 'st'

  if (!supportsOscProgressImpl(env, isTty, options)) {
    return { setIndeterminate: () => {}, setPercent: () => {}, clear: () => {} }
  }

  // OSC 9;4 progress is supported by some modern terminals (e.g. WezTerm).
  // We keep it stateful so we can switch between:
  // - indeterminate (state=3)
  // - determinate percent (state=1)
  // - clear/stop (state=0)
  const end = terminator === 'bel' ? OSC_PROGRESS_BEL : OSC_PROGRESS_ST

  const send = (state: number, percent: number | null, label: string) => {
    const cleanLabel = sanitizeLabel(label)
    if (percent == null) {
      write(`${OSC_PROGRESS_PREFIX}${state};;${cleanLabel}${end}`)
      return
    }
    const clamped = Math.max(0, Math.min(100, Math.round(percent)))
    write(`${OSC_PROGRESS_PREFIX}${state};${clamped};${cleanLabel}${end}`)
  }

  let lastLabel = options.label ?? 'Working…'

  return {
    setIndeterminate: (label) => {
      lastLabel = label
      send(3, null, label)
    },
    setPercent: (label, percent) => {
      lastLabel = label
      send(1, percent, label)
    },
    clear: () => {
      send(0, 0, lastLabel)
    },
  }
}
