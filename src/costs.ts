import type { LlmTokenUsage } from './llm/generate-text.js'

export type LlmProvider = 'xai' | 'openai' | 'google'

export type LlmCall = {
  provider: LlmProvider
  model: string
  usage: LlmTokenUsage | null
  purpose: 'summary' | 'chunk-notes' | 'markdown'
}

export type PricingConfig = {
  llm?: Record<
    string,
    { inputUsdPer1MTokens: number; outputUsdPer1MTokens: number } | undefined
  >
  firecrawlUsdPerRequest?: number
  apifyUsdPerRequest?: number
}

export type RunCostReport = {
  llm: Array<{
    provider: LlmProvider
    model: string
    calls: number
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
    estimatedUsd: number | null
  }>
  services: {
    firecrawl: { requests: number; estimatedUsd: number | null }
    apify: { requests: number; estimatedUsd: number | null }
  }
  totalEstimatedUsd: number | null
}

function sumOrNull(values: Array<number | null>): number | null {
  let sum = 0
  let any = false
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value
      any = true
    }
  }
  return any ? sum : null
}

function estimateLlmUsd({
  pricing,
  model,
  usage,
}: {
  pricing: PricingConfig | null
  model: string
  usage: { promptTokens: number | null; completionTokens: number | null }
}): number | null {
  const entry = pricing?.llm?.[model]
  if (!entry) return null
  if (usage.promptTokens === null || usage.completionTokens === null) return null
  const inputUsd = (usage.promptTokens / 1_000_000) * entry.inputUsdPer1MTokens
  const outputUsd = (usage.completionTokens / 1_000_000) * entry.outputUsdPer1MTokens
  return inputUsd + outputUsd
}

export function buildRunCostReport({
  llmCalls,
  firecrawlRequests,
  apifyRequests,
  pricing,
}: {
  llmCalls: LlmCall[]
  firecrawlRequests: number
  apifyRequests: number
  pricing: PricingConfig | null
}): RunCostReport {
  const llmMap = new Map<
    string,
    {
      provider: LlmProvider
      model: string
      calls: number
      promptTokens: Array<number | null>
      completionTokens: Array<number | null>
      totalTokens: Array<number | null>
    }
  >()

  for (const call of llmCalls) {
    const key = `${call.provider}:${call.model}`
    const existing = llmMap.get(key)
    const promptTokens = call.usage?.promptTokens ?? null
    const completionTokens = call.usage?.completionTokens ?? null
    const totalTokens = call.usage?.totalTokens ?? null
    if (!existing) {
      llmMap.set(key, {
        provider: call.provider,
        model: call.model,
        calls: 1,
        promptTokens: [promptTokens],
        completionTokens: [completionTokens],
        totalTokens: [totalTokens],
      })
      continue
    }
    existing.calls += 1
    existing.promptTokens.push(promptTokens)
    existing.completionTokens.push(completionTokens)
    existing.totalTokens.push(totalTokens)
  }

  const llm = Array.from(llmMap.values()).map((row) => {
    const promptTokens = sumOrNull(row.promptTokens)
    const completionTokens = sumOrNull(row.completionTokens)
    const totalTokens = sumOrNull(row.totalTokens)
    const estimatedUsd = estimateLlmUsd({
      pricing,
      model: row.model,
      usage: { promptTokens, completionTokens },
    })
    return {
      provider: row.provider,
      model: row.model,
      calls: row.calls,
      promptTokens,
      completionTokens,
      totalTokens,
      estimatedUsd,
    }
  })

  const firecrawlEstimatedUsd =
    typeof pricing?.firecrawlUsdPerRequest === 'number' && Number.isFinite(pricing.firecrawlUsdPerRequest)
      ? pricing.firecrawlUsdPerRequest * firecrawlRequests
      : null
  const apifyEstimatedUsd =
    typeof pricing?.apifyUsdPerRequest === 'number' && Number.isFinite(pricing.apifyUsdPerRequest)
      ? pricing.apifyUsdPerRequest * apifyRequests
      : null

  const totalEstimatedUsd = (() => {
    const pieces: Array<number | null> = [
      sumOrNull(llm.map((row) => row.estimatedUsd)),
      firecrawlEstimatedUsd,
      apifyEstimatedUsd,
    ]
    const total = sumOrNull(pieces)
    return total
  })()

  return {
    llm,
    services: {
      firecrawl: { requests: firecrawlRequests, estimatedUsd: firecrawlEstimatedUsd },
      apify: { requests: apifyRequests, estimatedUsd: apifyEstimatedUsd },
    },
    totalEstimatedUsd,
  }
}

export function parsePricingJson(input: string): PricingConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid JSON pricing config: ${message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid pricing config: expected an object at the top level')
  }

  const obj = parsed as Record<string, unknown>
  const pricing: PricingConfig = {}

  const llm = obj.llm
  if (llm && typeof llm === 'object' && !Array.isArray(llm)) {
    const llmObj = llm as Record<string, unknown>
    const normalized: PricingConfig['llm'] = {}
    for (const [model, value] of Object.entries(llmObj)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const row = value as Record<string, unknown>
      const inputUsdPer1MTokens =
        typeof row.inputUsdPer1MTokens === 'number' && Number.isFinite(row.inputUsdPer1MTokens)
          ? row.inputUsdPer1MTokens
          : null
      const outputUsdPer1MTokens =
        typeof row.outputUsdPer1MTokens === 'number' && Number.isFinite(row.outputUsdPer1MTokens)
          ? row.outputUsdPer1MTokens
          : null
      if (inputUsdPer1MTokens === null || outputUsdPer1MTokens === null) continue
      normalized[model] = { inputUsdPer1MTokens, outputUsdPer1MTokens }
    }
    pricing.llm = normalized
  }

  if (typeof obj.firecrawlUsdPerRequest === 'number' && Number.isFinite(obj.firecrawlUsdPerRequest)) {
    pricing.firecrawlUsdPerRequest = obj.firecrawlUsdPerRequest
  }
  if (typeof obj.apifyUsdPerRequest === 'number' && Number.isFinite(obj.apifyUsdPerRequest)) {
    pricing.apifyUsdPerRequest = obj.apifyUsdPerRequest
  }

  return pricing
}

