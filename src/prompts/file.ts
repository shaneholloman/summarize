import type { SummaryLengthTarget } from './link-summary.js'

export function buildFileSummaryPrompt({
  filename,
  mediaType,
  outputLanguage,
  summaryLength,
  contentLength,
}: {
  filename: string | null
  mediaType: string | null
  outputLanguage: string
  summaryLength: SummaryLengthTarget
  contentLength?: number | null
}): string {
  const languageInstruction =
    outputLanguage === 'auto'
      ? 'Write the response in the same language as the source content.'
      : `Write the response in ${outputLanguage}.`
  const contentCharacters = typeof contentLength === 'number' ? contentLength : null
  const effectiveSummaryLength =
    typeof summaryLength === 'string'
      ? summaryLength
      : contentCharacters &&
          contentCharacters > 0 &&
          summaryLength.maxCharacters > contentCharacters
        ? { maxCharacters: contentCharacters }
        : summaryLength
  const maxCharactersLine =
    typeof effectiveSummaryLength === 'string'
      ? ''
      : `Target length: up to ${effectiveSummaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`
  const contentLengthLine =
    contentCharacters && contentCharacters > 0
      ? `Extracted content length: ${contentCharacters.toLocaleString()} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`
      : ''

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    mediaType ? `Media type: ${mediaType}` : null,
  ].filter(Boolean)

  const prompt = `You summarize files for curious users. ${languageInstruction} Summarize the attached file. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine} ${contentLengthLine}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`

  return prompt
}

export function buildFileTextSummaryPrompt({
  filename,
  originalMediaType,
  contentMediaType,
  outputLanguage,
  summaryLength,
  contentLength,
}: {
  filename: string | null
  originalMediaType: string | null
  contentMediaType: string
  outputLanguage: string
  summaryLength: SummaryLengthTarget
  contentLength: number
}): string {
  const languageInstruction =
    outputLanguage === 'auto'
      ? 'Write the response in the same language as the source content.'
      : `Write the response in ${outputLanguage}.`
  const effectiveSummaryLength =
    typeof summaryLength === 'string'
      ? summaryLength
      : summaryLength.maxCharacters > contentLength
        ? { maxCharacters: contentLength }
        : summaryLength
  const maxCharactersLine =
    typeof effectiveSummaryLength === 'string'
      ? ''
      : `Target length: up to ${effectiveSummaryLength.maxCharacters.toLocaleString()} characters total (including Markdown and whitespace). Hard limit: do not exceed it.`

  const headerLines = [
    filename ? `Filename: ${filename}` : null,
    originalMediaType ? `Original media type: ${originalMediaType}` : null,
    `Provided as: ${contentMediaType}`,
    `Extracted content length: ${contentLength.toLocaleString()} characters. Hard limit: never exceed this length. If the requested length is larger, do not pad—finish early rather than adding filler.`,
  ].filter(Boolean)

  return `You summarize files for curious users. ${languageInstruction} Summarize the file content below. Be factual and do not invent details. Format the answer in Markdown. Do not use emojis. ${maxCharactersLine}

${headerLines.length > 0 ? `${headerLines.join('\n')}\n\n` : ''}Return only the summary.`
}
