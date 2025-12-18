import { describe, expect, it, vi } from 'vitest'

const generateTextWithModelIdMock = vi.fn(async () => ({
  text: '# Hello',
  canonicalModelId: 'openai/gpt-5.2',
  provider: 'openai',
}))

vi.mock('../src/llm/generate-text.js', () => ({
  generateTextWithModelId: generateTextWithModelIdMock,
}))

describe('HTML→Markdown converter', async () => {
  const { createHtmlToMarkdownConverter } = await import('../src/llm/html-to-markdown.js')

  it('passes system + prompt to generateTextWithModelId', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createHtmlToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const result = await converter({
      url: 'https://example.com',
      title: 'Example',
      siteName: 'Example',
      html: '<html><body><h1>Hello</h1></body></html>',
      timeoutMs: 2000,
    })

    expect(result).toBe('# Hello')
    expect(generateTextWithModelIdMock).toHaveBeenCalledTimes(1)
    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as {
      system?: string
      prompt: string
      temperature: number
      modelId: string
    }
    expect(args.modelId).toBe('openai/gpt-5.2')
    expect(args.temperature).toBe(0)
    expect(args.system).toContain('You convert HTML')
    expect(args.prompt).toContain('URL: https://example.com')
    expect(args.prompt).toContain('<h1>Hello</h1>')
  })

  it('truncates very large HTML inputs', async () => {
    generateTextWithModelIdMock.mockClear()

    const converter = createHtmlToMarkdownConverter({
      modelId: 'openai/gpt-5.2',
      xaiApiKey: null,
      googleApiKey: null,
      openaiApiKey: 'test',
      fetchImpl: globalThis.fetch.bind(globalThis),
    })

    const html = `<html><body>${'A'.repeat(200_005)}MARKER</body></html>`
    await converter({
      url: 'https://example.com',
      title: null,
      siteName: null,
      html,
      timeoutMs: 2000,
    })

    const args = generateTextWithModelIdMock.mock.calls[0]?.[0] as { prompt: string }
    expect(args.prompt).not.toContain('MARKER')
  })
})
