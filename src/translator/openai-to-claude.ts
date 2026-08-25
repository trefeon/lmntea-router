import { ChatCompletionRequestSchema } from '../schemas/chat.js'

export interface ClaudeTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export interface ClaudeImageBlock {
  type: 'image'
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string }
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export interface ClaudeToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export interface ClaudeToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | ClaudeTextBlock[] | ClaudeImageBlock[]
  is_error?: boolean
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export interface ClaudeThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface ClaudeDocumentBlock {
  type: 'document'
  source: { type: 'base64'; media_type: string; data: string }
  cache_control?: { type: 'ephemeral'; ttl?: string }
}

export type ClaudeContentBlock =
  | ClaudeTextBlock
  | ClaudeImageBlock
  | ClaudeToolUseBlock
  | ClaudeToolResultBlock
  | ClaudeThinkingBlock
  | ClaudeDocumentBlock
  | { type: 'redacted_thinking'; data: string }

export interface ClaudeMessage {
  role: 'user' | 'assistant'
  content: ClaudeContentBlock[]
}

export interface ClaudeRequest {
  model: string
  system?: string | ClaudeTextBlock[]
  messages: ClaudeMessage[]
  max_tokens?: number
  temperature?: number
  top_p?: number
  top_k?: number
  stream?: boolean
  stop_sequences?: string[]
  tools?: {
    name: string
    description?: string
    input_schema: Record<string, unknown>
    cache_control?: { type: 'ephemeral'; ttl?: string }
  }[]
  tool_choice?: {
    type: 'auto' | 'any' | 'tool'
    name?: string
    disable_parallel_tool_use?: boolean
  }
  thinking?: { type: 'enabled' | 'disabled'; budget_tokens?: number }
  metadata?: { user_id?: string }
}

const EFFORT_BUDGET: Record<string, number> = {
  none: 0,
  off: 0,
  low: 1024,
  medium: 8192,
  high: 32768,
  max: 131072,
  xhigh: 131072,
  minimal: 512,
}

function sanitizeIdentifier(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (s.length === 0) s = 'unknown_tool'
  if (s.length > 64) s = s.slice(0, 64)
  return s
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!m || m[1] === undefined || m[2] === undefined) return null
  return { mimeType: m[1], data: m[2] }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const p of content) {
      if (
        p &&
        typeof p === 'object' &&
        'type' in (p as Record<string, unknown>)
      ) {
        const rec = p as Record<string, unknown>
        if (rec.type === 'text' && typeof rec.text === 'string')
          texts.push(rec.text)
        else if (typeof rec.text === 'string') texts.push(rec.text)
      } else if (typeof p === 'string') {
        texts.push(p)
      }
    }
    return texts.join('\n')
  }
  if (
    content &&
    typeof content === 'object' &&
    'text' in (content as Record<string, unknown>)
  ) {
    const t = (content as Record<string, unknown>).text
    if (typeof t === 'string') return t
  }
  if (content === null || content === undefined) return ''
  return String(content)
}

function contentToClaudeBlocks(content: unknown): ClaudeContentBlock[] {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') {
    if (content.length === 0) return []
    return [{ type: 'text', text: content }]
  }
  if (Array.isArray(content)) {
    const blocks: ClaudeContentBlock[] = []
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const rec = part as Record<string, unknown>
      const t = rec.type as string | undefined
      const cache = rec.cache_control as
        | { type: 'ephemeral'; ttl?: string }
        | undefined
      if (t === 'text' && typeof rec.text === 'string') {
        const b: ClaudeTextBlock = { type: 'text', text: rec.text }
        if (cache) b.cache_control = cache
        blocks.push(b)
      } else if (
        t === 'image_url' &&
        rec.image_url &&
        typeof rec.image_url === 'object'
      ) {
        const img = rec.image_url as Record<string, unknown>
        const url = typeof img.url === 'string' ? img.url : ''
        if (!url) continue
        const parsed = parseDataUrl(url)
        if (parsed) {
          const b: ClaudeImageBlock = {
            type: 'image',
            source: {
              type: 'base64',
              media_type: parsed.mimeType,
              data: parsed.data,
            },
          }
          if (cache) b.cache_control = cache
          blocks.push(b)
        } else {
          const b: ClaudeImageBlock = {
            type: 'image',
            source: { type: 'url', url },
          }
          if (cache) b.cache_control = cache
          blocks.push(b)
        }
      } else if (
        t === 'input_audio' &&
        rec.input_audio &&
        typeof rec.input_audio === 'object'
      ) {
        blocks.push({ type: 'text', text: '[Audio content not supported]' })
      } else if (t === 'file' && rec.file && typeof rec.file === 'object') {
        const file = rec.file as Record<string, unknown>
        const fileData =
          typeof file.file_data === 'string' ? file.file_data : ''
        const parsed = fileData ? parseDataUrl(fileData) : null
        if (parsed) {
          const b: ClaudeDocumentBlock = {
            type: 'document',
            source: {
              type: 'base64',
              media_type: parsed.mimeType,
              data: parsed.data,
            },
          }
          if (cache) b.cache_control = cache
          blocks.push(b)
        } else if (typeof rec.text === 'string') {
          const b: ClaudeTextBlock = { type: 'text', text: rec.text }
          if (cache) b.cache_control = cache
          blocks.push(b)
        }
      } else if (typeof rec.text === 'string') {
        const b: ClaudeTextBlock = { type: 'text', text: rec.text }
        if (cache) b.cache_control = cache
        blocks.push(b)
      }
    }
    return blocks
  }
  const txt = extractText(content)
  if (txt) return [{ type: 'text', text: txt }]
  return []
}

function buildTools(tools: unknown): ClaudeRequest['tools'] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const out: NonNullable<ClaudeRequest['tools']> = []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const rec = t as Record<string, unknown>
    const fn = (rec.function ?? rec) as Record<string, unknown>
    if (!fn || typeof fn !== 'object') continue
    const nameRaw = typeof fn.name === 'string' ? fn.name : undefined
    if (!nameRaw) continue
    const name = sanitizeIdentifier(nameRaw)
    const description =
      typeof fn.description === 'string' ? fn.description : undefined
    const params = fn.parameters ??
      fn.input_schema ?? { type: 'object', properties: {} }
    const inputSchema =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : { type: 'object', properties: {} }
    const entry: NonNullable<ClaudeRequest['tools']>[number] = {
      name,
      input_schema: inputSchema,
    }
    if (description) entry.description = description
    const cache = rec.cache_control as
      | { type: 'ephemeral'; ttl?: string }
      | undefined
    if (cache) entry.cache_control = cache
    out.push(entry)
  }
  if (out.length === 0) return undefined
  const cacheCount = out.filter(
    (tool) => tool.cache_control !== undefined,
  ).length
  if (cacheCount > 4) {
    let seen = 0
    for (let i = out.length - 1; i >= 0; i--) {
      const tool = out[i]
      if (tool === undefined) continue
      if (tool.cache_control !== undefined) {
        seen++
        // biome-ignore lint/performance/noDelete: exactOptionalPropertyTypes requires delete
        if (seen > 4) delete tool.cache_control
      }
    }
  }
  return out
}

function buildToolChoice(
  toolChoice: unknown,
): ClaudeRequest['tool_choice'] | undefined {
  if (toolChoice === undefined || toolChoice === null) return undefined
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none') return { type: 'auto' }
    if (toolChoice === 'auto') return { type: 'auto' }
    if (toolChoice === 'required') return { type: 'any' }
    return { type: 'auto' }
  }
  if (typeof toolChoice === 'object') {
    const rec = toolChoice as Record<string, unknown>
    if (
      rec.type === 'function' &&
      rec.function &&
      typeof rec.function === 'object'
    ) {
      const fn = rec.function as Record<string, unknown>
      const name =
        typeof fn.name === 'string' ? sanitizeIdentifier(fn.name) : undefined
      if (name) return { type: 'tool', name }
    }
    const t = typeof rec.type === 'string' ? rec.type : undefined
    if (t === 'auto' || t === 'any' || t === 'tool') {
      const name =
        typeof rec.name === 'string' ? sanitizeIdentifier(rec.name) : undefined
      if (t === 'tool' && name) return { type: 'tool', name }
      if (t === 'any') return { type: 'any' }
      return { type: 'auto' }
    }
  }
  return undefined
}

function resolveThinking(
  body: Record<string, unknown>,
): ClaudeRequest['thinking'] | undefined {
  const thinkingRaw = body.thinking as Record<string, unknown> | undefined
  if (thinkingRaw && typeof thinkingRaw === 'object') {
    const type = thinkingRaw.type as string | undefined
    const budget = thinkingRaw.budget_tokens as unknown
    if (type === 'enabled' && typeof budget === 'number' && budget > 0) {
      return { type: 'enabled', budget_tokens: budget }
    }
    if (type === 'disabled') return { type: 'disabled' }
    if (typeof budget === 'number' && budget > 0) {
      return { type: 'enabled', budget_tokens: budget }
    }
  }
  const effort = body.reasoning_effort as unknown
  if (typeof effort === 'string') {
    const key = effort.toLowerCase()
    const budget = EFFORT_BUDGET[key]
    if (budget !== undefined) {
      if (budget === 0) return { type: 'disabled' }
      return { type: 'enabled', budget_tokens: budget }
    }
  }
  const reasoning = body.reasoning as Record<string, unknown> | undefined
  if (
    reasoning &&
    typeof reasoning === 'object' &&
    typeof reasoning.effort === 'string'
  ) {
    const key = (reasoning.effort as string).toLowerCase()
    const budget = EFFORT_BUDGET[key]
    if (budget !== undefined) {
      if (budget === 0) return { type: 'disabled' }
      return { type: 'enabled', budget_tokens: budget }
    }
  }
  return undefined
}

function fixToolUseOrdering(messages: ClaudeMessage[]): ClaudeMessage[] {
  for (const msg of messages) {
    if (
      msg.role === 'assistant' &&
      msg.content.some((b) => b.type === 'tool_use')
    ) {
      const newContent: ClaudeContentBlock[] = []
      let foundToolUse = false
      for (const block of msg.content) {
        if (block.type === 'tool_use') {
          foundToolUse = true
          newContent.push(block)
        } else if (
          block.type === 'thinking' ||
          block.type === 'redacted_thinking'
        ) {
          newContent.push(block)
        } else if (!foundToolUse) {
          newContent.push(block)
        }
      }
      msg.content = newContent
    }
  }

  const merged: ClaudeMessage[] = []
  for (const msg of messages) {
    const last = merged[merged.length - 1]
    if (last !== undefined && last.role === msg.role) {
      const lastContent = last.content
      const curContent = msg.content
      const toolResults = [
        ...lastContent.filter((b) => b.type === 'tool_result'),
        ...curContent.filter((b) => b.type === 'tool_result'),
      ]
      const others = [
        ...lastContent.filter((b) => b.type !== 'tool_result'),
        ...curContent.filter((b) => b.type !== 'tool_result'),
      ]
      last.content = [...toolResults, ...others]
    } else {
      merged.push({ role: msg.role, content: [...msg.content] })
    }
  }
  return merged
}

function enforceCacheControlLimit(
  messages: ClaudeMessage[],
  system?: ClaudeRequest['system'],
): void {
  const allBlocks: { cache_control?: { type: 'ephemeral'; ttl?: string } }[] =
    []
  if (Array.isArray(system)) {
    allBlocks.push(...system)
  }
  for (const m of messages) {
    for (const b of m.content) {
      const rec = b as unknown as Record<string, unknown>
      if ('cache_control' in rec && rec.cache_control !== undefined) {
        allBlocks.push(
          b as { cache_control?: { type: 'ephemeral'; ttl?: string } },
        )
      }
    }
  }
  if (allBlocks.length > 4) {
    let toRemove = allBlocks.length - 4
    if (Array.isArray(system)) {
      for (const block of system) {
        if (toRemove <= 0) break
        if (block.cache_control !== undefined) {
          // biome-ignore lint/performance/noDelete: cache control limit
          delete block.cache_control
          toRemove--
        }
      }
    }
    for (const m of messages) {
      if (toRemove <= 0) break
      for (const b of m.content) {
        const rec = b as unknown as Record<string, unknown>
        if (rec.cache_control !== undefined) {
          // biome-ignore lint/performance/noDelete: cache control limit
          delete rec.cache_control
          toRemove--
          if (toRemove <= 0) break
        }
      }
    }
  }
}

export function openaiToClaude(input: unknown): ClaudeRequest {
  const parsed = ChatCompletionRequestSchema.safeParse(input)
  if (!parsed.success) {
    throw parsed.error
  }
  const body = parsed.data as unknown as Record<string, unknown>

  const model =
    typeof body.model === 'string'
      ? body.model
      : String(body.model ?? 'unknown')

  const rawMessages = Array.isArray(body.messages)
    ? (body.messages as unknown[])
    : []
  const systemTexts: string[] = []
  const systemBlocks: ClaudeTextBlock[] = []
  let hasSystemCacheControl = false
  const nonSystemRaw: unknown[] = []

  for (const m of rawMessages) {
    if (!m || typeof m !== 'object') {
      nonSystemRaw.push(m)
      continue
    }
    const rec = m as Record<string, unknown>
    const role = rec.role as string | undefined
    if (role === 'system' || role === 'developer') {
      const content = rec.content
      const cacheAtMessage = rec.cache_control as
        | { type: 'ephemeral'; ttl?: string }
        | undefined
      if (typeof content === 'string') {
        if (cacheAtMessage) {
          systemBlocks.push({
            type: 'text',
            text: content,
            cache_control: cacheAtMessage,
          })
          hasSystemCacheControl = true
        } else {
          systemTexts.push(content)
          systemBlocks.push({ type: 'text', text: content })
        }
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (!part || typeof part !== 'object') continue
          const pRec = part as Record<string, unknown>
          const t = pRec.type as string | undefined
          const txt = typeof pRec.text === 'string' ? pRec.text : undefined
          if (t === 'text' && txt !== undefined) {
            const cache =
              (pRec.cache_control as
                | { type: 'ephemeral'; ttl?: string }
                | undefined) ?? cacheAtMessage
            if (cache) hasSystemCacheControl = true
            const block: ClaudeTextBlock = { type: 'text', text: txt }
            if (cache) block.cache_control = cache
            systemBlocks.push(block)
            if (!cache) systemTexts.push(txt)
          } else if (txt !== undefined) {
            const cache =
              (pRec.cache_control as
                | { type: 'ephemeral'; ttl?: string }
                | undefined) ?? cacheAtMessage
            if (cache) hasSystemCacheControl = true
            const block: ClaudeTextBlock = { type: 'text', text: txt }
            if (cache) block.cache_control = cache
            systemBlocks.push(block)
            if (!cache) systemTexts.push(txt)
          }
        }
      } else if (content !== null && content !== undefined) {
        const txt = extractText(content)
        if (txt) {
          if (cacheAtMessage) {
            systemBlocks.push({
              type: 'text',
              text: txt,
              cache_control: cacheAtMessage,
            })
            hasSystemCacheControl = true
          } else {
            systemTexts.push(txt)
            systemBlocks.push({ type: 'text', text: txt })
          }
        }
      }
      continue
    }
    nonSystemRaw.push(m)
  }

  let system: ClaudeRequest['system'] | undefined
  if (systemBlocks.length > 0) {
    if (hasSystemCacheControl) {
      system = systemBlocks
    } else {
      const joined =
        systemTexts.length > 0
          ? systemTexts.join('\n\n')
          : systemBlocks.map((b) => b.text).join('\n\n')
      if (joined) system = joined
    }
  }

  const tools = buildTools(body.tools)
  const toolChoice = buildToolChoice(body.tool_choice)
  const thinking = resolveThinking(body)

  const toolIdToName = new Map<string, string>()
  for (const m of nonSystemRaw) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    if (rec.role === 'assistant' && Array.isArray(rec.tool_calls)) {
      for (const tc of rec.tool_calls as unknown[]) {
        if (!tc || typeof tc !== 'object') continue
        const r = tc as Record<string, unknown>
        const id = typeof r.id === 'string' ? r.id : undefined
        const fn = r.function as Record<string, unknown> | undefined
        const name = fn && typeof fn.name === 'string' ? fn.name : undefined
        if (id && name) toolIdToName.set(id, sanitizeIdentifier(name))
      }
    }
  }

  const naiveMessages: ClaudeMessage[] = []

  for (const m of nonSystemRaw) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    const roleRaw = rec.role as string | undefined

    if (roleRaw === 'assistant') {
      const blocks: ClaudeContentBlock[] = []

      const reasoningContent = (rec.reasoning_content ??
        rec.reasoning) as unknown
      if (typeof reasoningContent === 'string' && reasoningContent.length > 0) {
        const thinkBlock: ClaudeThinkingBlock = {
          type: 'thinking',
          thinking: reasoningContent,
        }
        const sig =
          (rec.signature as unknown) ??
          (rec.thoughtSignature as unknown) ??
          (rec.thought_signature as unknown)
        if (typeof sig === 'string' && sig.length > 0)
          thinkBlock.signature = sig
        blocks.push(thinkBlock)
      }

      const contentBlocks = contentToClaudeBlocks(rec.content)
      const msgCache = rec.cache_control as
        | { type: 'ephemeral'; ttl?: string }
        | undefined
      if (msgCache && contentBlocks.length > 0) {
        const last = contentBlocks[contentBlocks.length - 1] as Record<
          string,
          unknown
        >
        if (last) last.cache_control = msgCache
      }
      blocks.push(...contentBlocks)

      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls as unknown[]) {
          if (!tc || typeof tc !== 'object') continue
          const r = tc as Record<string, unknown>
          const id =
            typeof r.id === 'string'
              ? r.id
              : `call_${Math.random().toString(36).slice(2, 8)}`
          const fn = r.function as Record<string, unknown> | undefined
          const nameRaw =
            fn && typeof fn.name === 'string' ? fn.name : undefined
          const name = nameRaw ? sanitizeIdentifier(nameRaw) : 'unknown_tool'
          let input: Record<string, unknown> = {}
          const argsRaw = fn?.arguments as unknown
          if (typeof argsRaw === 'string') {
            const s = argsRaw.trim()
            if (s) {
              try {
                const parsedArgs = JSON.parse(s)
                if (
                  parsedArgs &&
                  typeof parsedArgs === 'object' &&
                  !Array.isArray(parsedArgs)
                ) {
                  input = parsedArgs as Record<string, unknown>
                }
              } catch {
                // keep empty on parse failure
              }
            }
          } else if (
            argsRaw &&
            typeof argsRaw === 'object' &&
            !Array.isArray(argsRaw)
          ) {
            input = argsRaw as Record<string, unknown>
          }
          const useBlock: ClaudeToolUseBlock = {
            type: 'tool_use',
            id,
            name,
            input,
          }
          const tcCache = r.cache_control as
            | { type: 'ephemeral'; ttl?: string }
            | undefined
          if (tcCache) useBlock.cache_control = tcCache
          blocks.push(useBlock)
          const idForMap = typeof r.id === 'string' ? r.id : id
          if (nameRaw) toolIdToName.set(idForMap, sanitizeIdentifier(nameRaw))
        }
      }

      if (blocks.length === 0) {
        blocks.push({ type: 'text', text: '' })
      }

      naiveMessages.push({ role: 'assistant', content: blocks })
    } else if (roleRaw === 'tool') {
      const toolCallId =
        typeof rec.tool_call_id === 'string'
          ? rec.tool_call_id
          : typeof rec.toolCallId === 'string'
            ? rec.toolCallId
            : undefined
      const nameFromMap = toolCallId ? toolIdToName.get(toolCallId) : undefined
      const explicitName = typeof rec.name === 'string' ? rec.name : undefined
      const isOrphan = Boolean(toolCallId && !nameFromMap && !explicitName)

      if (isOrphan) {
        const rawContent = rec.content
        const textFallback =
          typeof rawContent === 'string'
            ? `[Unmatched tool output ${toolCallId}]: ${rawContent}`
            : `[Unmatched tool output ${toolCallId}]: ${JSON.stringify(rawContent)}`
        const block: ClaudeTextBlock = { type: 'text', text: textFallback }
        const cache = rec.cache_control as
          | { type: 'ephemeral'; ttl?: string }
          | undefined
        if (cache) block.cache_control = cache
        naiveMessages.push({ role: 'user', content: [block] })
        continue
      }

      const rawContent = rec.content
      let contentStr: string
      if (typeof rawContent === 'string') contentStr = rawContent
      else if (Array.isArray(rawContent))
        contentStr = JSON.stringify(rawContent)
      else if (rawContent && typeof rawContent === 'object')
        contentStr = JSON.stringify(rawContent)
      else contentStr = String(rawContent ?? '')

      const block: ClaudeToolResultBlock = {
        type: 'tool_result',
        tool_use_id: toolCallId ?? 'unknown',
        content: contentStr,
      }
      const isError = rec.is_error as boolean | undefined
      if (isError === true) block.is_error = true
      const cache = rec.cache_control as
        | { type: 'ephemeral'; ttl?: string }
        | undefined
      if (cache) block.cache_control = cache
      naiveMessages.push({ role: 'user', content: [block] })
    } else {
      const blocks = contentToClaudeBlocks(rec.content)
      const msgCache = rec.cache_control as
        | { type: 'ephemeral'; ttl?: string }
        | undefined
      if (msgCache && blocks.length > 0) {
        const last = blocks[blocks.length - 1] as Record<string, unknown>
        if (last) last.cache_control = msgCache
      }
      const finalBlocks =
        blocks.length > 0
          ? blocks
          : ([
              { type: 'text', text: '' } as ClaudeTextBlock,
            ] as ClaudeContentBlock[])
      naiveMessages.push({ role: 'user', content: finalBlocks })
    }
  }

  const repaired: ClaudeMessage[] = []
  let idx = 0
  while (idx < naiveMessages.length) {
    const cur = naiveMessages[idx]
    if (cur === undefined) {
      idx++
      continue
    }
    if (
      cur.role === 'assistant' &&
      cur.content.some((b) => b.type === 'tool_use')
    ) {
      repaired.push(cur)
      const pendingIds = new Set(
        cur.content
          .filter((b) => b.type === 'tool_use')
          .map((b) => (b as ClaudeToolUseBlock).id),
      )
      const collectedToolResults: ClaudeContentBlock[] = []
      const deferredUsers: ClaudeMessage[] = []
      let j = idx + 1
      while (j < naiveMessages.length) {
        const nxt = naiveMessages[j]
        if (nxt === undefined) {
          j++
          continue
        }
        if (nxt.role === 'assistant') break
        const isToolResultMsg =
          nxt.content.length > 0 &&
          nxt.content.every((b) => b.type === 'tool_result')
        if (isToolResultMsg) {
          for (const b of nxt.content) {
            if (
              b.type === 'tool_result' &&
              pendingIds.has((b as ClaudeToolResultBlock).tool_use_id)
            ) {
              collectedToolResults.push(b)
              pendingIds.delete((b as ClaudeToolResultBlock).tool_use_id)
            } else if (b.type === 'tool_result') {
              const contentStr =
                typeof (b as ClaudeToolResultBlock).content === 'string'
                  ? ((b as ClaudeToolResultBlock).content as string)
                  : JSON.stringify((b as ClaudeToolResultBlock).content)
              collectedToolResults.push({
                type: 'text',
                text: `[Unmatched tool output ${(b as ClaudeToolResultBlock).tool_use_id}]: ${contentStr}`,
              } as ClaudeTextBlock)
            }
          }
          j++
          continue
        }
        if (pendingIds.size > 0 && nxt.role === 'user') {
          deferredUsers.push(nxt)
          j++
          continue
        }
        break
      }
      if (collectedToolResults.length > 0) {
        repaired.push({ role: 'user', content: collectedToolResults })
      }
      for (const du of deferredUsers) {
        repaired.push(du)
      }
      idx = j
      continue
    }
    repaired.push(cur)
    idx++
  }

  const merged = fixToolUseOrdering(repaired)

  enforceCacheControlLimit(merged, system)

  const out: ClaudeRequest = {
    model,
    messages: merged,
  }

  if (system !== undefined) out.system = system

  const maxTok = body.max_tokens as number | undefined
  const maxComp = body.max_completion_tokens as number | undefined
  const effectiveMax =
    typeof maxTok === 'number'
      ? maxTok
      : typeof maxComp === 'number'
        ? maxComp
        : undefined
  if (effectiveMax !== undefined) {
    out.max_tokens = effectiveMax
  } else if (
    thinking?.type === 'enabled' &&
    thinking.budget_tokens !== undefined
  ) {
    out.max_tokens = thinking.budget_tokens + 1024
  }

  if (thinking !== undefined) {
    out.thinking = thinking
    if (
      thinking.type === 'enabled' &&
      thinking.budget_tokens !== undefined &&
      out.max_tokens !== undefined
    ) {
      if (out.max_tokens <= thinking.budget_tokens) {
        out.max_tokens = thinking.budget_tokens + 1024
      }
    }
  }

  if (typeof body.temperature === 'number')
    out.temperature = body.temperature as number
  if (typeof body.top_p === 'number') out.top_p = body.top_p as number
  if (typeof (body as Record<string, unknown>).top_k === 'number')
    out.top_k = (body as Record<string, unknown>).top_k as number
  if (typeof body.stream === 'boolean') out.stream = body.stream
  if (body.stop !== undefined) {
    const stop = body.stop as unknown
    if (typeof stop === 'string') out.stop_sequences = [stop]
    else if (Array.isArray(stop) && stop.every((s) => typeof s === 'string'))
      out.stop_sequences = stop as string[]
  }
  if (body.stop_sequences !== undefined && Array.isArray(body.stop_sequences)) {
    const seq = body.stop_sequences as unknown[]
    if (seq.every((s) => typeof s === 'string'))
      out.stop_sequences = seq as string[]
  }
  if (tools !== undefined) out.tools = tools
  if (toolChoice !== undefined) out.tool_choice = toolChoice

  const userVal = body.user as unknown
  if (typeof userVal === 'string' && userVal.length > 0) {
    out.metadata = { user_id: userVal }
  }

  return out
}
