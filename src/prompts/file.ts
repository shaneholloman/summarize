import type { SummaryLengthTarget } from './link-summary.js'
import {
  estimateMaxCompletionTokensForCharacters,
  pickSummaryLengthForCharacters,
} from './link-summary.js'

const SUMMARY_LENGTH_TO_TOKENS: Record<'short' | 'medium' | 'long' | 'xl' | 'xxl', number> = {
  short: 768,
  medium: 1536,
  long: 3072,
  xl: 6144,
  xxl: 12288,
}

export function buildFileSummaryPrompt({
  filename,
  mediaType,
  summaryLength,
}: {
  filename: string | null
  mediaType: string | null
  summaryLength: SummaryLengthTarget
}): { prompt: string; maxOutputTokens: number } {
  const preset =
    typeof summaryLength === 'string'
      ? summaryLength
      : pickSummaryLengthForCharacters(summaryLength.maxCharacters)

  const maxCharactersLine =
    typeof summaryLength === 'string'
      ? ''
      : `Target length: around ${summaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). This is a soft guideline; prioritize clarity.`

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const maxOutputTokens =
    typeof summaryLength === 'string'
      ? (SUMMARY_LENGTH_TO_TOKENS[preset] ?? 1024)
      : estimateMaxCompletionTokensForCharacters(summaryLength.maxCharacters)

  const prompt = `You summarize files for curious users. Summarize the attached file. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`

  return { prompt, maxOutputTokens }
}
