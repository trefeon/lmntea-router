import { describe, expect, it } from 'vitest'
import {
  enforceToolResultAdjacency,
  mergeConsecutiveRoles,
  repairToolAdjacency,
} from '../../src/translator/tools.js'
import type { ChatMessage } from '../../src/translator/tools.js'

function user(content: string): ChatMessage {
  return { role: 'user', content }
}

function assistant(
  content: string | null,
  toolCalls?: ChatMessage['tool_calls'],
): ChatMessage {
  const m: ChatMessage = { role: 'assistant', content }
  if (toolCalls) m.tool_calls = toolCalls
  return m
}

function tool(toolCallId: string, content: string): ChatMessage {
  return { role: 'tool', tool_call_id: toolCallId, content }
}

describe('repairToolAdjacency — pure tool repair', () => {
  it('reorders interleaving user note to after tool results (spec §3.2)', () => {
    const input: ChatMessage[] = [
      assistant(null, [
        {
          id: 'call_A',
          type: 'function',
          function: { name: 'tool_A', arguments: '{}' },
        },
        {
          id: 'call_B',
          type: 'function',
          function: { name: 'tool_B', arguments: '{}' },
        },
      ]),
      user('User note midway'),
      tool('call_A', 'A_out'),
      tool('call_B', 'B_out'),
    ]

    const out = repairToolAdjacency(input)

    expect(out).toHaveLength(4)
    expect(out[0]!.role).toBe('assistant')
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.tool_call_id).toBe('call_A')
    expect(out[2]!.role).toBe('tool')
    expect(out[2]!.tool_call_id).toBe('call_B')
    // deferred user should be last, not between assistant and tools
    expect(out[3]!.role).toBe('user')
    expect(out[3]!.content).toBe('User note midway')

    // adjacency: tool immediately follows assistant
    expect(out[1]!.role).toBe('tool')
    expect(out[0]!.role).toBe('assistant')
  })

  it('converts orphan tool_result to user text fallback', () => {
    const input: ChatMessage[] = [
      user('hello'),
      tool('orphan_123', 'some output'),
    ]

    const out = repairToolAdjacency(input)

    // orphan tool becomes user and merges with preceding user (consecutive same-role merge)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.content).toBe(
      'hello\n[Unmatched tool output orphan_123]: some output',
    )
  })

  it('injects placeholder for missing tool result', () => {
    const input: ChatMessage[] = [
      assistant(null, [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
        },
      ]),
      user('next user turn'),
    ]

    const out = repairToolAdjacency(input)

    // assistant, placeholder tool, then user (merged? no — tool breaks merge)
    expect(out[0]!.role).toBe('assistant')
    expect(out[1]!.role).toBe('tool')
    expect(out[1]!.tool_call_id).toBe('call_1')
    expect(out[1]!.content).toBe('[Tool execution omitted]')
    expect(out[2]!.role).toBe('user')
    expect(out[2]!.content).toBe('next user turn')
  })

  it('merges consecutive same-role user messages', () => {
    const input: ChatMessage[] = [user('hello'), user('world'), user('!')]

    const out = repairToolAdjacency(input)

    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(out[0]!.content).toBe('hello\nworld\n!')
  })

  it('does not mutate input array', () => {
    const input: ChatMessage[] = [
      assistant(null, [
        { id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } },
      ]),
      tool('a', 'out'),
    ]
    const snapshot = JSON.parse(JSON.stringify(input))
    const out = repairToolAdjacency(input)
    expect(input).toEqual(snapshot)
    expect(out).not.toBe(input)
  })

  it('handles multiple tool_calls with partial missing and orphan mixed', () => {
    const input: ChatMessage[] = [
      assistant(null, [
        {
          id: 'call_A',
          type: 'function',
          function: { name: 'a', arguments: '{}' },
        },
        {
          id: 'call_B',
          type: 'function',
          function: { name: 'b', arguments: '{}' },
        },
      ]),
      tool('call_A', 'A_out'),
      tool('orphan', 'orphan_out'),
      // call_B missing — should be injected
    ]

    const out = repairToolAdjacency(input)

    // Expected: assistant, tool call_A, placeholder for call_B, user fallback for orphan (merged? but separated by placeholder tool)
    // After orphan conversion, orphan becomes user, and consecutive user merging may affect but orphan is after tools
    const roles = out.map((m) => m.role)
    expect(roles[0]).toBe('assistant')
    expect(roles[1]).toBe('tool')
    expect(out[1]!.tool_call_id).toBe('call_A')
    expect(roles[2]).toBe('tool')
    expect(out[2]!.tool_call_id).toBe('call_B')
    expect(out[2]!.content).toBe('[Tool execution omitted]')
    expect(roles[3]).toBe('user')
    expect(out[3]!.content).toBe('[Unmatched tool output orphan]: orphan_out')
  })

  it('enforceToolResultAdjacency is alias of repairToolAdjacency', () => {
    expect(enforceToolResultAdjacency).toBe(repairToolAdjacency)

    const input: ChatMessage[] = [user('hi')]
    expect(enforceToolResultAdjacency(input)).toEqual(
      repairToolAdjacency(input),
    )
  })

  it('mergeConsecutiveRoles merges assistant consecutive but preserves tool chain', () => {
    const input: ChatMessage[] = [
      assistant('part1'),
      assistant('part2'),
      tool('a', 'out1'),
      tool('b', 'out2'),
    ]
    // Directly test merge helper — assistants should merge, tools should stay separate
    const merged = mergeConsecutiveRoles(input)
    expect(merged).toHaveLength(3)
    expect(merged[0]!.role).toBe('assistant')
    expect(merged[0]!.content).toBe('part1\npart2')
    expect(merged[1]!.role).toBe('tool')
    expect(merged[2]!.role).toBe('tool')
  })

  it('handles empty array and no-tool messages unchanged (except merge)', () => {
    expect(repairToolAdjacency([])).toEqual([])
    const input: ChatMessage[] = [user('a'), assistant('b')]
    const out = repairToolAdjacency(input)
    expect(out).toEqual([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ])
  })

  it('produces array output with no I/O and preserves content for array parts', () => {
    const input: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'user', content: [{ type: 'text', text: 'there' }] },
    ]
    const out = repairToolAdjacency(input)
    expect(out).toHaveLength(1)
    expect(out[0]!.role).toBe('user')
    expect(Array.isArray(out[0]!.content)).toBe(true)
    expect(out[0]!.content).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'there' },
    ])
  })
})
