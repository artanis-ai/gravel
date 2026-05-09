/**
 * Smoke tests for the message normalizer. Each provider gets at
 * least one canonical request + response shape so a regression that
 * stops surfacing tool calls, images, or attachments shows up here.
 */
import { describe, it, expect } from 'vitest'
import { extractMessages, extractOutput } from './messages'

describe('extractMessages — OpenAI Chat Completions', () => {
  it('plain text request', () => {
    const input = {
      url: 'https://api.openai.com/v1/chat/completions',
      method: 'POST',
      body: {
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'Hi.' },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out).toHaveLength(2)
    expect(out[0]!.role).toBe('system')
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'You are helpful.' }])
    expect(out[1]!.role).toBe('user')
  })

  it('multimodal user message with image_url', () => {
    const input = {
      body: {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: "What's in this picture?" },
              { type: 'image_url', image_url: { url: 'https://example.com/cat.png' } },
            ],
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks).toEqual([
      { type: 'text', text: "What's in this picture?" },
      { type: 'image', url: 'https://example.com/cat.png' },
    ])
  })

  it('assistant message with tool_calls', () => {
    const input = {
      body: {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"London"}' },
              },
            ],
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks).toHaveLength(1)
    expect(out[0]!.blocks[0]).toEqual({
      type: 'tool_call',
      id: 'call_abc123',
      name: 'get_weather',
      input: { city: 'London' },
    })
  })

  it('tool message → tool_result block', () => {
    const input = {
      body: {
        messages: [
          { role: 'tool', tool_call_id: 'call_abc123', content: '{"temp":12}' },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'call_abc123',
      output: '{"temp":12}',
    })
  })
})

describe('extractMessages — Anthropic Messages', () => {
  it('system field + content blocks (text + image)', () => {
    const input = {
      body: {
        system: 'You are Claude.',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this.' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
              },
            ],
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]).toMatchObject({ role: 'system' })
    expect(out[1]!.blocks[0]).toEqual({ type: 'text', text: 'Describe this.' })
    expect(out[1]!.blocks[1]).toMatchObject({ type: 'image', mediaType: 'image/png' })
    // Image gets a data: URL so the renderer can show it inline.
    expect((out[1]!.blocks[1] as { url: string }).url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('tool_use + tool_result content blocks', () => {
    const input = {
      body: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Let me check.' },
              {
                type: 'tool_use',
                id: 'toolu_01',
                name: 'get_weather',
                input: { city: 'London' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_01',
                content: [{ type: 'text', text: 'Sunny, 12°C.' }],
              },
            ],
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks).toHaveLength(2)
    expect(out[0]!.blocks[1]).toMatchObject({ type: 'tool_call', name: 'get_weather' })
    expect(out[1]!.blocks[0]).toMatchObject({
      type: 'tool_result',
      toolCallId: 'toolu_01',
      output: 'Sunny, 12°C.',
    })
  })
})

describe('extractMessages — OpenAI Responses API', () => {
  it('input items with input_text + input_image', () => {
    const input = {
      body: {
        input: [
          {
            role: 'user',
            content: [
              { type: 'input_text', text: 'Describe.' },
              { type: 'input_image', image_url: 'https://example.com/x.png' },
            ],
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks).toEqual([
      { type: 'text', text: 'Describe.' },
      { type: 'image', url: 'https://example.com/x.png' },
    ])
  })

  it('function_call item', () => {
    const input = {
      body: {
        input: [
          {
            type: 'function_call',
            call_id: 'fc_1',
            name: 'lookup',
            arguments: '{"q":"hi"}',
          },
        ],
      },
    }
    const out = extractMessages(input)
    expect(out[0]!.blocks[0]).toEqual({
      type: 'tool_call',
      id: 'fc_1',
      name: 'lookup',
      input: { q: 'hi' },
    })
  })
})

describe('extractOutput', () => {
  it('OpenAI choices[0].message.content', () => {
    const out = extractOutput({
      choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('OpenAI assistant tool_calls land as blocks', () => {
    const out = extractOutput({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'search', arguments: '{"q":"x"}' },
              },
            ],
          },
        },
      ],
    })
    expect(out[0]!.blocks[0]).toMatchObject({ type: 'tool_call', name: 'search' })
  })

  it('Anthropic content blocks', () => {
    const out = extractOutput({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Hi.' },
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
      ],
    })
    expect(out[0]!.blocks).toHaveLength(2)
    expect(out[0]!.blocks[0]).toEqual({ type: 'text', text: 'Hi.' })
    expect(out[0]!.blocks[1]).toMatchObject({ type: 'tool_call', name: 'lookup' })
  })

  it('Vercel AI top-level text + reasoning + toolCalls', () => {
    const out = extractOutput({
      reasoning: 'I should look this up.',
      text: 'Sunny.',
      toolCalls: [{ toolCallId: 't1', toolName: 'weather', args: { city: 'London' } }],
    })
    expect(out[0]!.blocks).toEqual([
      { type: 'reasoning', text: 'I should look this up.' },
      { type: 'text', text: 'Sunny.' },
      { type: 'tool_call', id: 't1', name: 'weather', input: { city: 'London' } },
    ])
  })

  it('plain string falls through', () => {
    expect(extractOutput('hello')[0]!.blocks).toEqual([{ type: 'text', text: 'hello' }])
  })
})
