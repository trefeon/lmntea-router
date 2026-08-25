import { describe, expect, it } from 'vitest'
import { openaiToClaude } from '../../src/translator/openai-to-claude.js'

function outOf(body: Record<string, unknown>) {
  return openaiToClaude(body)
}

describe('openaiToClaude', () => {
  it('hoists single system message to system string', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    expect(out.system).toBe('You are helpful.')
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0]?.role).toBe('user')
    expect(out.messages[0]?.content[0]).toMatchObject({
      type: 'text',
      text: 'Hello',
    })
  })

  it('hoists multiple system and developer messages joined with double newline', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'developer', content: 'Be concise.' },
        { role: 'user', content: 'Hi' },
      ],
    })
    expect(out.system).toBe('You are helpful.\n\nBe concise.')
    expect(out.messages).toHaveLength(1)
  })

  it('preserves cache_control on system blocks as array', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'system',
          content: 'sys1',
          cache_control: { type: 'ephemeral' },
        },
        { role: 'system', content: 'sys2' },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(Array.isArray(out.system)).toBe(true)
    const sys = out.system as {
      type: string
      text: string
      cache_control?: unknown
    }[]
    expect(sys[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(sys[0]?.text).toBe('sys1')
  })

  it('merges consecutive same-role messages (role alternation)', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'third' },
      ],
    })
    expect(out.messages).toHaveLength(3)
    expect(out.messages[0]?.role).toBe('user')
    expect(
      out.messages[0]?.content.map((b) => (b as { text?: string }).text),
    ).toEqual(['first', 'second'])
    expect(out.messages[1]?.role).toBe('assistant')
    expect(
      out.messages[1]?.content.map((b) => (b as { text?: string }).text),
    ).toEqual(['a', 'b'])
  })

  it('maps tools to Claude tools (parameters -> input_schema)', () => {
    const out = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
    })
    expect(out.tools).toHaveLength(1)
    expect(out.tools?.[0]?.name).toBe('get_weather')
    expect(out.tools?.[0]?.input_schema).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    })
  })

  it('maps tool_calls to tool_use with parsed arguments', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'What is weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            },
          ],
        },
      ],
    })
    expect(out.messages).toHaveLength(2)
    const assistant = out.messages[1]
    expect(assistant?.role).toBe('assistant')
    const toolUse = assistant?.content.find((b) => b.type === 'tool_use') as
      | { type: string; id: string; name: string; input: unknown }
      | undefined
    expect(toolUse).toBeDefined()
    expect(toolUse?.id).toBe('call_1')
    expect(toolUse?.name).toBe('get_weather')
    expect(toolUse?.input).toEqual({ city: 'Paris' })
  })

  it('repairs tool adjacency: interleaving user note moved after tool_result', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_A',
              type: 'function',
              function: { name: 'tool_a', arguments: '{}' },
            },
            {
              id: 'call_B',
              type: 'function',
              function: { name: 'tool_b', arguments: '{}' },
            },
          ],
        },
        { role: 'user', content: 'User note midway' },
        { role: 'tool', tool_call_id: 'call_A', content: 'A_out' },
        { role: 'tool', tool_call_id: 'call_B', content: 'B_out' },
      ],
    })
    expect(out.messages[0]?.role).toBe('assistant')
    // After repair + merge, tool_results and deferred text are in same user message (alternation merge)
    // So we have assistant + user (tool_results + note). Verify tool_results come before note.
    expect(out.messages).toHaveLength(2)
    expect(out.messages[1]?.role).toBe('user')
    const toolResults = out.messages[1]?.content.filter(
      (b) => b.type === 'tool_result',
    )
    expect(toolResults).toHaveLength(2)
    expect((toolResults?.[0] as { tool_use_id: string }).tool_use_id).toBe(
      'call_A',
    )
    expect((toolResults?.[1] as { tool_use_id: string }).tool_use_id).toBe(
      'call_B',
    )
    const textBlocks = out.messages[1]?.content.filter((b) => b.type === 'text')
    expect(
      textBlocks?.some(
        (b) => (b as { text: string }).text === 'User note midway',
      ),
    ).toBe(true)
    // tool_results should be before text (priority ordering)
    const all = out.messages[1]?.content ?? []
    const firstToolIdx = all.findIndex((b) => b.type === 'tool_result')
    const noteIdx = all.findIndex(
      (b) =>
        b.type === 'text' &&
        (b as { text: string }).text === 'User note midway',
    )
    expect(firstToolIdx).toBeLessThan(noteIdx)
  })

  it('converts orphan tool to user text fallback', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'orphan_1', content: 'orphan payload' },
      ],
    })
    const userBlocks = out.messages.flatMap((m) => m.content)
    const orphanText = userBlocks.find(
      (b) =>
        b.type === 'text' &&
        (b as { text: string }).text.includes('Unmatched tool output orphan_1'),
    )
    expect(orphanText).toBeDefined()
    expect((orphanText as { text: string }).text).toBe(
      '[Unmatched tool output orphan_1]: orphan payload',
    )
  })

  it('maps reasoning_content to thinking block', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: 'final answer',
          reasoning_content: 'I need to think step by step',
        },
      ],
    })
    const assistant = out.messages[0]
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'I need to think step by step',
    })
    expect(assistant?.content[1]).toMatchObject({
      type: 'text',
      text: 'final answer',
    })
  })

  it('maps reasoning_effort to thinking.budget_tokens (medium -> 8192) and reconciles max_tokens', () => {
    const out = outOf({
      model: 'm',
      max_tokens: 1000,
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(out.max_tokens).toBe(9216)
  })

  it('maps reasoning_effort high to 32768 and low to 1024', () => {
    const low = outOf({
      model: 'm',
      reasoning_effort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(low.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    const high = outOf({
      model: 'm',
      reasoning_effort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(high.thinking).toEqual({ type: 'enabled', budget_tokens: 32768 })
  })

  it('converts image_url base64 to Claude image block and https to url', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo==' },
            },
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/photo.jpg' },
            },
          ],
        },
      ],
    })
    const parts = out.messages[0]?.content ?? []
    expect(parts[0]).toEqual({ type: 'text', text: 'Describe' })
    expect(parts[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'iVBORw0KGgo==',
      },
    })
    expect(parts[2]).toEqual({
      type: 'image',
      source: { type: 'url', url: 'https://example.com/photo.jpg' },
    })
  })

  it('preserves cache_control on content blocks up to 4 breakpoints', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'b', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'c', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'd', cache_control: { type: 'ephemeral' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'e', cache_control: { type: 'ephemeral' } },
          ],
        },
      ],
    })
    const allBlocks = out.messages.flatMap((m) => m.content)
    const cached = allBlocks.filter(
      (b) => (b as { cache_control?: unknown }).cache_control !== undefined,
    )
    expect(cached.length).toBeLessThanOrEqual(4)
  })

  it('handles stop string and array mapping', () => {
    const out1 = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stop: 'END',
    })
    expect(out1.stop_sequences).toEqual(['END'])
    const out2 = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      stop: ['END', 'STOP'],
    })
    expect(out2.stop_sequences).toEqual(['END', 'STOP'])
  })

  it('is pure function — does not mutate input', () => {
    const input = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
    }
    const copy = JSON.parse(JSON.stringify(input))
    outOf(input as Record<string, unknown>)
    expect(input).toEqual(copy)
  })

  it('throws ZodError on invalid input (missing model)', () => {
    expect(() =>
      outOf({
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as Record<string, unknown>),
    ).toThrow()
  })

  it('handles tool_calls with invalid JSON arguments gracefully', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'test', arguments: 'not-json' },
            },
          ],
        },
      ],
    })
    const toolUse = out.messages[0]?.content.find(
      (b) => b.type === 'tool_use',
    ) as { input: unknown } | undefined
    expect(toolUse?.input).toEqual({})
  })

  it('maps max_completion_tokens alias to max_tokens', () => {
    const out = outOf({
      model: 'm',
      max_completion_tokens: 2048,
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(out.max_tokens).toBe(2048)
  })

  it('merges tool_results into single user message after assistant', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'a', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result1' },
      ],
    })
    const toolMsgs = out.messages.filter((m) =>
      m.content.some((b) => b.type === 'tool_result'),
    )
    expect(toolMsgs.length).toBe(1)
    expect(
      toolMsgs[0]?.content.filter((b) => b.type === 'tool_result'),
    ).toHaveLength(1)
  })
})
