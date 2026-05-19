import { describe, expect, it } from 'vitest'
import {
  approxByteLength,
  dataUriKind,
  formatBytes,
  humaniseKey,
  looksLikeBase64,
  looksLikeUrl,
  tokensFromUsage,
} from './humanise.js'

describe('humaniseKey', () => {
  const cases: Array<[string, string]> = [
    ['', ''],
    ['prompt_tokens', 'Prompt Tokens'],
    ['inputTokens', 'Input Tokens'],
    ['request_id', 'Request ID'],
    ['tool-use', 'Tool Use'],
    ['gpt4o_mini', 'Gpt4o Mini'],
    ['api_key', 'API Key'],
    ['model_id', 'Model ID'],
    ['http_status', 'HTTP Status'],
    ['ttl_seconds', 'TTL Seconds'],
    ['llm_output', 'LLM Output'],
    ['response_metadata', 'Response Metadata'],
    ['ToolCallId', 'Tool Call ID'],
  ]
  for (const [input, want] of cases) {
    it(`${input} → ${want}`, () => expect(humaniseKey(input)).toBe(want))
  }
})

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [256, '256 B'],
    [1024, '1.0 KB'],
    [2048, '2.0 KB'],
    [1234567, '1.2 MB'],
  ])('%d → %s', (n, want) => {
    expect(formatBytes(n)).toBe(want)
  })
})

describe('approxByteLength', () => {
  it('ascii is 1 byte per char', () => {
    expect(approxByteLength('hello')).toBe(5)
  })
  it('multi-byte counts utf-8 bytes, not js code units', () => {
    expect(approxByteLength('café')).toBe(5)
    expect(approxByteLength('🦊')).toBe(4)
  })
})

describe('looksLikeBase64', () => {
  it('short strings are rejected', () => {
    expect(looksLikeBase64('aGVsbG8=')).toBe(false)
  })
  it('long base64-shaped strings are accepted', () => {
    const blob = 'A'.repeat(150) + '=='
    expect(looksLikeBase64(blob)).toBe(true)
  })
  it('long human prose is rejected', () => {
    const prose =
      'This is a longer paragraph of prose that goes on for a while and has spaces and punctuation, so it should not pass.'
    expect(looksLikeBase64(prose)).toBe(false)
  })
})

describe('dataUriKind', () => {
  it('detects image data URIs', () => {
    expect(dataUriKind('data:image/png;base64,abcdef')).toBe('image')
    expect(dataUriKind('data:image/jpeg;base64,abcdef')).toBe('image')
  })
  it('detects audio data URIs', () => {
    expect(dataUriKind('data:audio/wav;base64,abcdef')).toBe('audio')
  })
  it('returns null for non-data URIs and unsupported kinds', () => {
    expect(dataUriKind('https://example.com/x.png')).toBeNull()
    expect(dataUriKind('data:text/plain;base64,abc')).toBeNull()
  })
})

describe('looksLikeUrl', () => {
  it('accepts http/https URLs', () => {
    expect(looksLikeUrl('https://example.com')).toBe(true)
    expect(looksLikeUrl('http://localhost:3000/x')).toBe(true)
  })
  it('rejects non-URL strings', () => {
    expect(looksLikeUrl('example.com')).toBe(false)
    expect(looksLikeUrl('hello world')).toBe(false)
    expect(looksLikeUrl('mailto:x@y.com')).toBe(false)
  })
})

describe('tokensFromUsage', () => {
  it('reads OpenAI snake_case', () => {
    expect(
      tokensFromUsage({ prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }),
    ).toEqual({ input: 12, output: 8, total: 20, reasoning: null })
  })
  it('reads Anthropic snake_case', () => {
    expect(tokensFromUsage({ input_tokens: 5, output_tokens: 9 })).toEqual({
      input: 5,
      output: 9,
      total: null,
      reasoning: null,
    })
  })
  it('reads Vercel AI v4+ camelCase', () => {
    expect(
      tokensFromUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7 }),
    ).toEqual({ input: 3, output: 4, total: 7, reasoning: null })
  })
  it('reads Gemini Python snake_case', () => {
    expect(
      tokensFromUsage({
        prompt_token_count: 12,
        candidates_token_count: 3,
        total_token_count: 15,
      }),
    ).toEqual({ input: 12, output: 3, total: 15, reasoning: null })
  })
  it('reads Gemini TS camelCase', () => {
    expect(
      tokensFromUsage({
        promptTokenCount: 5,
        candidatesTokenCount: 2,
        totalTokenCount: 7,
      }),
    ).toEqual({ input: 5, output: 2, total: 7, reasoning: null })
  })
  it('reads Gemini reasoning tokens (`thoughts_token_count`)', () => {
    // Captured shape from a real `gemini-flash-latest` call 2026-05-19.
    expect(
      tokensFromUsage({
        prompt_token_count: 7,
        candidates_token_count: 1,
        total_token_count: 66,
        thoughts_token_count: 58,
        service_tier: 'standard',
      }),
    ).toEqual({ input: 7, output: 1, total: 66, reasoning: 58 })
  })
  it('reads OpenAI o-series reasoning tokens (`reasoning_tokens`)', () => {
    expect(
      tokensFromUsage({
        prompt_tokens: 20,
        completion_tokens: 15,
        total_tokens: 75,
        reasoning_tokens: 40,
      }),
    ).toEqual({ input: 20, output: 15, total: 75, reasoning: 40 })
  })
  it('returns null when no recognisable keys are present', () => {
    expect(tokensFromUsage({ foo: 1 })).toBeNull()
    expect(tokensFromUsage(null)).toBeNull()
    expect(tokensFromUsage('x')).toBeNull()
  })
})
