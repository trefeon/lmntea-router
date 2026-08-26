/**
 * Tool adjacency & orphan repair — pure, no I/O.
 *
 * Invariants from research/universal_protocol_translation_spec.md §3.2
 * and devdocs/01-ARCHITECTURE.md §2.1 step 4:
 *  - tool result must immediately follow the assistant that issued tool_calls
 *  - orphan tool_result → user-text fallback `[Unmatched tool output <id>]: <content>`
 *  - missing tool result → inject placeholder `{ role: 'tool', tool_call_id, content: '[Tool execution omitted]' }`
 *  - consecutive same-role turns merged (Gemini/Anthropic strict alternation)
 */

export type ToolCall = {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export type ChatMessage = {
  role: string
  content?: unknown
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
  [key: string]: unknown
}

function cloneMessage(m: ChatMessage): ChatMessage {
  const c: ChatMessage = { ...m }
  if (Array.isArray(m.tool_calls)) {
    c.tool_calls = m.tool_calls.map((tc) => ({
      ...tc,
      function: { ...tc.function },
    }))
  }
  if (Array.isArray(m.content)) {
    c.content = [...(m.content as unknown[])]
  }
  return c
}

function extractText(content: unknown): string {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content as unknown[]
    const texts: string[] = []
    for (const p of parts) {
      if (p != null && typeof p === 'object') {
        const obj = p as Record<string, unknown>
        if (typeof obj.text === 'string') {
          texts.push(obj.text)
        } else if (typeof obj.content === 'string') {
          texts.push(obj.content)
        }
      } else if (typeof p === 'string') {
        texts.push(p)
      }
    }
    return texts.filter(Boolean).join('\n')
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content)
}

function mergeContents(a: unknown, b: unknown): unknown {
  if (a == null) return b
  if (b == null) return a
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === '') return b
    if (b === '') return a
    return `${a}\n${b}`
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return [...(a as unknown[]), ...(b as unknown[])]
  }
  if (Array.isArray(a) && typeof b === 'string') {
    return [...(a as unknown[]), { type: 'text', text: b }]
  }
  if (typeof a === 'string' && Array.isArray(b)) {
    return [{ type: 'text', text: a }, ...(b as unknown[])]
  }
  // fallback: stringify both
  const ta = extractText(a)
  const tb = extractText(b)
  if (ta === '') return tb
  if (tb === '') return ta
  return `${ta}\n${tb}`
}

/**
 * Merge consecutive messages with the same role.
 * Tool messages are intentionally NOT merged — each carries a distinct tool_call_id
 * that would be lost on merge. For assistant messages, tool_calls arrays are concatenated.
 */
export function mergeConsecutiveRoles(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 1) return messages.map(cloneMessage)
  const merged: ChatMessage[] = []
  for (const msg of messages) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && prev.role === msg.role) {
      // Do not merge consecutive tool messages — preserve distinct tool_call_id
      if (msg.role === 'tool') {
        merged.push(cloneMessage(msg))
        continue
      }
      // Merge content
      const nextContent = mergeContents(prev.content, msg.content)
      prev.content = nextContent

      // Merge tool_calls if present
      const aCalls = Array.isArray(prev.tool_calls)
        ? prev.tool_calls
        : undefined
      const bCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined
      if (aCalls !== undefined || bCalls !== undefined) {
        const combined: ToolCall[] = [...(aCalls ?? []), ...(bCalls ?? [])]
        if (combined.length > 0) {
          prev.tool_calls = combined
        }
      }

      // Preserve name if missing on prev but present on current
      if (prev.name === undefined && msg.name !== undefined) {
        prev.name = msg.name
      }
    } else {
      merged.push(cloneMessage(msg))
    }
  }
  return merged
}

/**
 * Core adjacency repair: enforce that every `role:tool` immediately follows its
 * originating `assistant.tool_calls`, reordering interleaving user turns,
 * injecting missing placeholders, and leaving orphans for the next pass.
 */
function enforceAdjacency(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return []

  const cloned = messages.map(cloneMessage)
  const output: ChatMessage[] = []
  const consumed = new Set<number>()

  for (let i = 0; i < cloned.length; i++) {
    if (consumed.has(i)) continue
    const msg = cloned[i]
    if (msg === undefined) continue

    // Push current message (clone already)
    output.push(msg)

    // Only assistant with tool_calls triggers reordering
    if (
      msg.role === 'assistant' &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      const expectedIds = msg.tool_calls.map((c) => c.id)
      const remaining = new Set<string>(expectedIds)
      const collected: ChatMessage[] = []
      const deferredUsers: ChatMessage[] = []

      // Look ahead until next assistant (exclusive) or end
      for (let j = i + 1; j < cloned.length; j++) {
        if (consumed.has(j)) continue
        const nxt = cloned[j]
        if (nxt === undefined) continue

        // Boundary: next assistant starts a new turn — stop collecting for current
        if (nxt.role === 'assistant') break

        if (
          nxt.role === 'tool' &&
          typeof nxt.tool_call_id === 'string' &&
          remaining.has(nxt.tool_call_id)
        ) {
          collected.push(cloneMessage(nxt))
          consumed.add(j)
          remaining.delete(nxt.tool_call_id)
          // If we've matched all expected, we stop deferring further users;
          // the next user after this point is a legitimate next turn, not interleaving.
          // But we may still need to collect remaining deferred users already queued.
          // We continue scanning only to find any other matching tool that was out-of-order
          // before the break — however if remaining is empty, we break at next non-tool.
          continue
        }

        if (
          nxt.role === 'tool' &&
          typeof nxt.tool_call_id === 'string' &&
          !remaining.has(nxt.tool_call_id)
        ) {
          // Tool for a different assistant (or orphan) — leave it for later, do not consume
          continue
        }

        // Non-tool message between assistant and its expected tools → interleaving
        // Only defer if we still have pending expected tools; otherwise this is a genuine next turn
        if (remaining.size > 0) {
          // Consider user/system/developer as deferrable; tool already handled above
          if (
            nxt.role === 'user' ||
            nxt.role === 'system' ||
            nxt.role === 'developer'
          ) {
            deferredUsers.push(cloneMessage(nxt))
            consumed.add(j)
          } else if (nxt.role !== 'assistant' && nxt.role !== 'tool') {
            deferredUsers.push(cloneMessage(nxt))
            consumed.add(j)
          }
        } else {
          // No more pending tools — the interleaving window is closed
          // Stop lookahead; leave nxt for outer loop
          break
        }
      }

      // Inject placeholders for any still-missing tool results
      for (const missingId of remaining) {
        collected.push({
          role: 'tool',
          tool_call_id: missingId,
          content: '[Tool execution omitted]',
        })
      }

      // Emit in correct order: tools immediately after assistant, then deferred users
      // Remove the assistant we already pushed? No — we pushed assistant already, now insert after it
      // So we need to insert collected + deferred after the last pushed element (which is assistant)
      // Since output already has assistant at end, we just push.
      output.push(...collected)
      output.push(...deferredUsers)
    }
  }

  return output
}

/**
 * Second pass: orphan tool_results that are not immediately adjacent to their
 * originating assistant are converted to user-text fallback.
 *
 * Adjacency definition: a tool message is valid iff it is contiguous with the
 * preceding assistant block — i.e., the immediately preceding non-consumed messages
 * form a chain: assistant(tool_calls) → tool* (contiguous, no interleaving) and
 * the tool's id is in that assistant's tool_calls.
 */
function repairOrphans(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return []

  const out: ChatMessage[] = []
  // Track the current valid tool block: { ids: Set<string>, startIdx in out, endIdx in out }
  let blockIds: Set<string> | null = null
  let blockEnd = -1
  let blockActive = false

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg === undefined) continue

    if (
      msg.role === 'assistant' &&
      Array.isArray(msg.tool_calls) &&
      msg.tool_calls.length > 0
    ) {
      out.push(cloneMessage(msg))
      blockIds = new Set(msg.tool_calls.map((c) => c.id))
      blockEnd = out.length - 1
      blockActive = true
      continue
    }

    if (msg.role === 'tool') {
      const tid =
        typeof msg.tool_call_id === 'string' ? msg.tool_call_id : undefined
      const isContiguous = blockActive && out.length === blockEnd + 1
      const isExpected =
        tid !== undefined && blockIds !== null && blockIds.has(tid)

      if (isContiguous && isExpected) {
        // Valid adjacency — keep as tool and extend block
        out.push(cloneMessage(msg))
        blockEnd = out.length - 1
        // Remove to prevent duplicate acceptance (duplicate id would then be orphan)
        blockIds?.delete(tid as string)
        continue
      }

      // Orphan: convert to user fallback
      const rawContent = extractText(msg.content)
      const fallbackText =
        tid !== undefined
          ? `[Unmatched tool output ${tid}]: ${rawContent}`
          : `[Unmatched tool output]: ${rawContent}`
      // If we already have a trailing user message, merging will happen later;
      // for now emit as standalone user.
      out.push({
        role: 'user',
        content: fallbackText,
      })
      // Orphan breaks contiguity of current block
      blockActive = false
      blockIds = null
      continue
    }

    // Any non-tool, non-assistant-tool_calls message breaks contiguity for tool block
    out.push(cloneMessage(msg))
    // If it's not a tool, adjacency chain is broken — future tools cannot be contiguous to earlier assistant
    // But we keep blockActive only for immediate contiguous tools; a user/system breaks it
    if (msg.role !== 'tool') {
      blockActive = false
      blockIds = null
    }
  }

  return out
}

/**
 * Public entry: repair tool adjacency, orphan fallback, missing fill, and
 * consecutive same-role merge. Pure — never mutates input.
 */
export function repairToolAdjacency(messages: ChatMessage[]): ChatMessage[] {
  if (!Array.isArray(messages)) return []
  if (messages.length === 0) return []

  // Shallow defensive copy not needed — sub-passes clone internally
  const afterAdjacency = enforceAdjacency(messages)
  const afterOrphan = repairOrphans(afterAdjacency)
  const afterMerge = mergeConsecutiveRoles(afterOrphan)
  return afterMerge
}

/** Alias required by ARCHITECTURE.md module table */
export const enforceToolResultAdjacency = repairToolAdjacency
