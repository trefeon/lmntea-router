import { describe, expect, it } from 'vitest'
import { openaiToGemini } from '../../src/translator/openai-to-gemini.js'

type GeminiOut = {
  systemInstruction?: { parts: { text: string }[] }
  contents: { role: string; parts: Record<string, unknown>[] }[]
  tools?: {
    functionDeclarations: {
      name: string
      description?: string
      parameters?: unknown
    }[]
  }[]
  toolConfig?: Record<string, unknown>
  generationConfig?: Record<string, unknown>
}

function asOut(v: Record<string, unknown>): GeminiOut {
  return v as unknown as GeminiOut
}

function outOf(body: Record<string, unknown>): GeminiOut {
  return asOut(openaiToGemini(body))
}

describe('openaiToGemini', () => {
  it('hoists system and developer to systemInstruction', () => {
    const out = outOf({
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'developer', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
    })
    expect(out.systemInstruction).toEqual({
      parts: [{ text: 'You are helpful.\n\nBe concise.' }],
    })
    expect(out.contents).toHaveLength(1)
    expect(out.contents[0]?.role).toBe('user')
    const firstPart = out.contents[0]?.parts[0] as
      | Record<string, unknown>
      | undefined
    expect(firstPart?.text).toBe('Hello')
  })

  it('maps roles assistant->model and user->user', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'How are you?' },
      ],
    })
    expect(out.contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    const p0 = out.contents[0]?.parts[0] as Record<string, unknown> | undefined
    expect(p0?.text).toBe('Hi')
    const p1 = out.contents[1]?.parts[0] as Record<string, unknown> | undefined
    expect(p1?.text).toBe('Hello!')
  })

  it('merges consecutive same-role messages', () => {
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
    expect(out.contents).toHaveLength(3)
    expect(out.contents[0]?.role).toBe('user')
    expect(
      out.contents[0]?.parts.map((p) => (p as Record<string, unknown>).text),
    ).toEqual(['first', 'second'])
    expect(out.contents[1]?.role).toBe('model')
    expect(
      out.contents[1]?.parts.map((p) => (p as Record<string, unknown>).text),
    ).toEqual(['a', 'b'])
    const lastPart = out.contents[2]?.parts[0] as
      | Record<string, unknown>
      | undefined
    expect(lastPart?.text).toBe('third')
  })

  it('converts text and image_url (data url -> inlineData, https -> fileData)', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe image' },
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
    const parts = out.contents[0]?.parts ?? []
    expect(parts[0]).toEqual({ text: 'Describe image' })
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo==' },
    })
    expect(parts[2]).toEqual({
      fileData: {
        fileUri: 'https://example.com/photo.jpg',
        mimeType: 'image/jpeg',
      },
    })
  })

  it('maps reasoning_content to thought part and preserves thoughtSignature', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: 'final answer',
          reasoning_content: 'I need to think step by step',
          thoughtSignature: 'sig-123',
        },
      ],
    })
    const parts = out.contents[0]?.parts ?? []
    expect(parts[0]).toEqual({
      thought: true,
      text: 'I need to think step by step',
      thoughtSignature: 'sig-123',
    })
    expect(parts[1]).toEqual({ text: 'final answer' })
  })

  it('handles thoughtSignature on tool_calls', () => {
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
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              thoughtSignature: 'sig-tool-1',
            },
          ],
        },
      ],
    })
    const parts = out.contents[0]?.parts ?? []
    expect(
      parts.some(
        (p) => (p as Record<string, unknown>).thoughtSignature === 'sig-tool-1',
      ),
    ).toBe(true)
    const fc = parts.find(
      (p) => (p as Record<string, unknown>).functionCall !== undefined,
    ) as Record<string, unknown> | undefined
    const call = fc?.functionCall as Record<string, unknown> | undefined
    expect(call?.name).toBe('get_weather')
    expect(call?.args).toEqual({ city: 'Paris' })
  })

  it('converts tool_calls to functionCall and tool result to functionResponse', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_a',
              type: 'function',
              function: { name: 'grep', arguments: '{"pattern":"TODO"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_a', content: '{"matches": 3}' },
      ],
    })
    expect(out.contents[0]?.role).toBe('model')
    const part0 = out.contents[0]?.parts[0] as
      | Record<string, unknown>
      | undefined
    const fc = part0?.functionCall as Record<string, unknown> | undefined
    expect(fc).toEqual({ name: 'grep', args: { pattern: 'TODO' } })
    expect(out.contents[1]?.role).toBe('user')
    const part1 = out.contents[1]?.parts[0] as
      | Record<string, unknown>
      | undefined
    const fr = part1?.functionResponse as Record<string, unknown> | undefined
    expect((fr as Record<string, unknown>)?.name).toBe('grep')
    expect((fr as Record<string, unknown>)?.response).toEqual({ matches: 3 })
  })

  it('orphan tool output becomes text fallback merged with preceding user', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', tool_call_id: 'orphan_1', content: 'some output' },
      ],
    })
    // consecutive user roles merge: hi + orphan -> one content with two parts
    expect(out.contents).toHaveLength(1)
    expect(out.contents[0]?.role).toBe('user')
    const parts = out.contents[0]?.parts ?? []
    expect(parts[0]).toEqual({ text: 'hi' })
    const p = parts[1] as Record<string, unknown> | undefined
    expect(p?.text).toBe('[Unmatched tool output orphan_1]: some output')
  })

  it('translates tools definitions to functionDeclarations and strips $ref', () => {
    const out = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'my-tool',
            description: 'does thing',
            parameters: {
              type: 'object',
              properties: {
                a: { type: 'string' },
                nested: { $ref: '#/definitions/Foo' },
              },
              $defs: { Foo: { type: 'string' } },
            },
          },
        },
      ],
    })
    expect(out.tools).toBeDefined()
    const decl = out.tools?.[0]?.functionDeclarations[0]
    expect(decl?.name).toBe('my-tool')
    expect(decl?.description).toBe('does thing')
    expect(decl?.parameters).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, nested: {} },
    })
  })

  it('builds generationConfig from reasoning_effort, max_tokens, temperature, top_p, stop', () => {
    const out = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
      max_tokens: 2048,
      temperature: 0.7,
      top_p: 0.9,
      stop: ['END', 'STOP'],
    })
    expect(out.generationConfig?.maxOutputTokens).toBe(2048)
    expect(out.generationConfig?.temperature).toBe(0.7)
    expect(out.generationConfig?.topP).toBe(0.9)
    expect(out.generationConfig?.stopSequences).toEqual(['END', 'STOP'])
    expect(out.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 8192,
      includeThoughts: true,
    })
  })

  it('handles max_completion_tokens as fallback and thinking disabled', () => {
    const out = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 4096,
      reasoning_effort: 'none',
    })
    expect(out.generationConfig?.maxOutputTokens).toBe(4096)
    expect(out.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: false,
    })
  })

  it('tool_choice maps to toolConfig', () => {
    const none = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'none',
    })
    expect(none.toolConfig).toEqual({ functionCallingConfig: { mode: 'NONE' } })

    const required = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
    })
    expect(required.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' },
    })

    const specific = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'function', function: { name: 'my_fn' } },
    })
    expect(specific.toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['my_fn'] },
    })
  })

  it('handles string content and array text parts', () => {
    const out1 = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'plain string' }],
    })
    expect(out1.contents[0]?.parts).toEqual([{ text: 'plain string' }])

    const out2 = outOf({
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' },
          ],
        },
      ],
    })
    expect(out2.contents[0]?.parts).toEqual([{ text: 'a' }, { text: 'b' }])
  })

  it('pure function does not mutate input', () => {
    const input: Record<string, unknown> = {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
    }
    const copy = JSON.parse(JSON.stringify(input)) as unknown
    openaiToGemini(input)
    expect(input).toEqual(copy)
  })

  it('handles system instruction with array content', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'system',
          content: [
            { type: 'text', text: 'sys1' },
            { type: 'text', text: 'sys2' },
          ],
        },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(out.systemInstruction?.parts[0]?.text).toBe('sys1\nsys2')
  })

  it('maps reasoning_effort minimal to thinkingBudget 512', () => {
    const out = outOf({
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'minimal',
    })
    expect(out.generationConfig?.thinkingConfig).toEqual({
      thinkingBudget: 512,
      includeThoughts: true,
    })
  })

  it('throws ZodError on invalid input (missing model)', () => {
    expect(() =>
      outOf({
        messages: [{ role: 'user', content: 'hi' }],
      } as unknown as Record<string, unknown>),
    ).toThrow()
  })

  it('merges bare thoughtSignature onto adjacent parts instead of emitting standalone parts', () => {
    const out = outOf({
      model: 'm',
      messages: [
        {
          role: 'assistant',
          content: 'answer',
          reasoning_content: 'hmm',
          thoughtSignature: 'sig-a',
        },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'f', arguments: '{}' },
              thoughtSignature: 'sig-b',
            },
          ],
        },
      ],
    })
    // consecutive model contents merge into one; no bare signature part remains
    expect(out.contents).toHaveLength(1)
    const parts = out.contents[0]?.parts ?? []
    expect(parts[0]).toEqual({
      thought: true,
      text: 'hmm',
      thoughtSignature: 'sig-a',
    })
    expect(parts[1]).toEqual({ text: 'answer' })
    expect(parts[2]?.thoughtSignature).toBe('sig-b')
    expect(parts[2]?.functionCall).toEqual({ name: 'f', args: {} })
    expect(
      parts.some(
        (p) =>
          p.functionCall === undefined &&
          p.text === undefined &&
          p.inlineData === undefined &&
          p.fileData === undefined &&
          p.thoughtSignature !== undefined,
      ),
    ).toBe(false)
  })

  it('routes malformed tool output without tool_call_id through the unmatched-text path', () => {
    const out = outOf({
      model: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'tool', content: 'stray output' },
      ],
    })
    const parts = out.contents.flatMap((c) => c.parts)
    expect(parts.some((p) => p.functionResponse !== undefined)).toBe(false)
    const stray = parts.find(
      (p) =>
        typeof p.text === 'string' &&
        p.text.startsWith('[Unmatched tool output]'),
    )
    expect(stray?.text).toContain('stray output')
  })
})
