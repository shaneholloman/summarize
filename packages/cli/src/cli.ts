#!/usr/bin/env node
import { createLinkPreviewClient } from '@steipete/summarizer/content'
import {
  buildLinkSummaryPrompt,
  SUMMARY_LENGTH_TO_TOKENS,
  type SummaryLength,
} from '@steipete/summarizer/prompts'

type CliArgs = {
  url: string | null
  length: SummaryLength
  model: string
  printPrompt: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    url: null,
    length: 'medium',
    model: process.env.OPENAI_MODEL ?? 'gpt-5.2',
    printPrompt: false,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i]
    if (!value) {
      continue
    }

    if (value === '--') {
      continue
    }

    if (value === '--prompt') {
      args.printPrompt = true
      continue
    }

    if (value === '--length') {
      const next = argv[i + 1]
      if (!next) {
        throw new Error('--length expects a value')
      }
      i += 1
      if (!isSummaryLength(next)) {
        throw new Error(`Unsupported --length: ${next}`)
      }
      args.length = next
      continue
    }

    if (value === '--model') {
      const next = argv[i + 1]
      if (!next) {
        throw new Error('--model expects a value')
      }
      i += 1
      args.model = next
      continue
    }

    if (value.startsWith('-')) {
      throw new Error(`Unknown flag: ${value}`)
    }

    if (!args.url) {
      args.url = value
      continue
    }

    throw new Error(`Unexpected extra arg: ${value}`)
  }

  return args
}

function isSummaryLength(value: string): value is SummaryLength {
  return (
    value === 'short' || value === 'medium' || value === 'long' || value === 'xl' || value === 'xxl'
  )
}

async function summarizeWithOpenAI({
  apiKey,
  model,
  prompt,
  maxOutputTokens,
}: {
  apiKey: string
  model: string
  prompt: string
  maxOutputTokens: number
}): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_completion_tokens: maxOutputTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`OpenAI request failed (${response.status}): ${body}`)
  }

  const json = (await response.json()) as unknown
  const content = readFirstChoiceContent(json)
  if (!content) {
    throw new Error('OpenAI response missing message content')
  }
  return content
}

function readFirstChoiceContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const choices = (payload as Record<string, unknown>).choices
  if (!Array.isArray(choices) || choices.length === 0) {
    return null
  }
  const first = choices[0]
  if (!first || typeof first !== 'object') {
    return null
  }
  const message = (first as Record<string, unknown>).message
  if (!message || typeof message !== 'object') {
    return null
  }
  const content = (message as Record<string, unknown>).content
  return typeof content === 'string' ? content : null
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.url) {
    throw new Error(
      'Usage: summarize <url> [--length short|medium|long|xl|xxl] [--model <model>] [--prompt]'
    )
  }

  const client = createLinkPreviewClient({
    apifyApiToken:
      typeof process.env.APIFY_API_TOKEN === 'string' ? process.env.APIFY_API_TOKEN : null,
  })
  const extracted = await client.fetchLinkContent(args.url)

  const prompt = buildLinkSummaryPrompt({
    url: extracted.url,
    title: extracted.title,
    siteName: extracted.siteName,
    description: extracted.description,
    content: extracted.content,
    truncated: extracted.truncated,
    hasTranscript:
      extracted.transcriptSource !== null && extracted.transcriptSource !== 'unavailable',
    summaryLength: args.length,
    shares: [],
  })

  if (args.printPrompt) {
    process.stdout.write(`${prompt}\n`)
    return
  }

  const apiKey = typeof process.env.OPENAI_API_KEY === 'string' ? process.env.OPENAI_API_KEY : null
  if (!apiKey) {
    process.stderr.write('Missing OPENAI_API_KEY; printing prompt instead.\n')
    process.stdout.write(`${prompt}\n`)
    return
  }

  const summary = await summarizeWithOpenAI({
    apiKey,
    model: args.model,
    prompt,
    maxOutputTokens: SUMMARY_LENGTH_TO_TOKENS[args.length],
  })

  process.stdout.write(`${summary.trim()}\n`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
