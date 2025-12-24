const NORMALIZE_PATTERN = /[^a-z0-9-]+/g

export type OutputLanguage = {
  /** Best-effort BCP-47-ish tag (e.g. "en", "de", "pt-br") */
  tag: string
  /** Human label used in prompts (e.g. "English", "German") */
  label: string
}

const LANGUAGE_ALIASES: Record<string, OutputLanguage> = {
  auto: { tag: 'auto', label: 'auto' },

  en: { tag: 'en', label: 'English' },
  'en-us': { tag: 'en-US', label: 'English' },
  'en-gb': { tag: 'en-GB', label: 'English' },
  english: { tag: 'en', label: 'English' },

  de: { tag: 'de', label: 'German' },
  'de-de': { tag: 'de-DE', label: 'German' },
  german: { tag: 'de', label: 'German' },
  deutsch: { tag: 'de', label: 'German' },

  es: { tag: 'es', label: 'Spanish' },
  spanish: { tag: 'es', label: 'Spanish' },
  espanol: { tag: 'es', label: 'Spanish' },
  'es-es': { tag: 'es-ES', label: 'Spanish' },
  'es-mx': { tag: 'es-MX', label: 'Spanish' },

  fr: { tag: 'fr', label: 'French' },
  french: { tag: 'fr', label: 'French' },

  it: { tag: 'it', label: 'Italian' },
  italian: { tag: 'it', label: 'Italian' },

  pt: { tag: 'pt', label: 'Portuguese' },
  portuguese: { tag: 'pt', label: 'Portuguese' },
  'pt-br': { tag: 'pt-BR', label: 'Portuguese (Brazil)' },
  'pt-pt': { tag: 'pt-PT', label: 'Portuguese (Portugal)' },

  nl: { tag: 'nl', label: 'Dutch' },
  dutch: { tag: 'nl', label: 'Dutch' },

  sv: { tag: 'sv', label: 'Swedish' },
  swedish: { tag: 'sv', label: 'Swedish' },

  no: { tag: 'no', label: 'Norwegian' },
  norwegian: { tag: 'no', label: 'Norwegian' },

  da: { tag: 'da', label: 'Danish' },
  danish: { tag: 'da', label: 'Danish' },

  fi: { tag: 'fi', label: 'Finnish' },
  finnish: { tag: 'fi', label: 'Finnish' },

  pl: { tag: 'pl', label: 'Polish' },
  polish: { tag: 'pl', label: 'Polish' },

  cs: { tag: 'cs', label: 'Czech' },
  czech: { tag: 'cs', label: 'Czech' },

  tr: { tag: 'tr', label: 'Turkish' },
  turkish: { tag: 'tr', label: 'Turkish' },

  ru: { tag: 'ru', label: 'Russian' },
  russian: { tag: 'ru', label: 'Russian' },

  uk: { tag: 'uk', label: 'Ukrainian' },
  ukrainian: { tag: 'uk', label: 'Ukrainian' },

  zh: { tag: 'zh', label: 'Chinese' },
  chinese: { tag: 'zh', label: 'Chinese' },
  'zh-cn': { tag: 'zh-CN', label: 'Chinese (Simplified)' },
  'zh-hans': { tag: 'zh-Hans', label: 'Chinese (Simplified)' },
  'zh-tw': { tag: 'zh-TW', label: 'Chinese (Traditional)' },
  'zh-hant': { tag: 'zh-Hant', label: 'Chinese (Traditional)' },

  ja: { tag: 'ja', label: 'Japanese' },
  japanese: { tag: 'ja', label: 'Japanese' },

  ko: { tag: 'ko', label: 'Korean' },
  korean: { tag: 'ko', label: 'Korean' },

  ar: { tag: 'ar', label: 'Arabic' },
  arabic: { tag: 'ar', label: 'Arabic' },

  hi: { tag: 'hi', label: 'Hindi' },
  hindi: { tag: 'hi', label: 'Hindi' },
}

function titleCaseAscii(value: string): string {
  const words = value
    .split(/[\s-]+/g)
    .map((w) => w.trim())
    .filter(Boolean)
  if (words.length === 0) return 'English'
  return words
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

export function resolveOutputLanguage(raw: string | null | undefined): OutputLanguage {
  const normalized = (raw ?? '').trim()
  if (!normalized) return { tag: 'auto', label: 'auto' }

  const compact = normalized
    .toLowerCase()
    .replaceAll('_', '-')
    .replaceAll(NORMALIZE_PATTERN, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '')

  // eslint-disable-next-line security/detect-object-injection
  const known = LANGUAGE_ALIASES[compact]
  if (known) return known

  // Best-effort: allow passing arbitrary tags/names through to the model, but keep it safe/short.
  const fallbackTag = compact.length > 0 ? compact.slice(0, 32) : 'en'
  const fallbackLabel = titleCaseAscii(normalized).slice(0, 48)
  return { tag: fallbackTag, label: fallbackLabel }
}
