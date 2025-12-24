import type { SummaryLengthTarget } from './link-summary.js'

function formatTargetLength(summaryLength: SummaryLengthTarget): string {
  if (typeof summaryLength === 'string') return ''
  const max = summaryLength.maxCharacters
  return `Target length: around ${max.toLocaleString()} characters total (including Markdown and whitespace). This is a soft guideline; prioritize clarity.`
}

export function buildPathSummaryPrompt({
  kindLabel,
  filePath,
  filename,
  mediaType,
  outputLanguage,
  summaryLength,
}: {
  kindLabel: 'file' | 'image'
  filePath: string
  filename: string | null
  mediaType: string | null
  outputLanguage: string
  summaryLength: SummaryLengthTarget
}): string {
  const languageInstruction =
    outputLanguage === 'auto'
      ? 'Write the response in the same language as the source content.'
      : `Write the response in ${outputLanguage}.`
  const headerLines = [
    `Path: ${filePath}`,
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const maxCharactersLine = formatTargetLength(summaryLength)
  return `You summarize ${kindLabel === 'image' ? 'images' : 'files'} for curious users. ${languageInstruction} Summarize the ${kindLabel} at the path below. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`
}
