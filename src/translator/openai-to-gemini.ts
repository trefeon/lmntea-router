export interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  fileData?: { fileUri: string; mimeType: string }
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] }
  contents: GeminiContent[]
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

const effortToGeminiBudget: Record<string, number> = {
  none: 0,
  off: 0,
  low: 1024,
  medium: 8192,
  high: 24576,
  max: 32768,
  xhigh: 32768,
}

function sanitizeIdentifier(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, '_')
  if (s.length === 0) s = 'unknown_tool'
  if (s.length > 64) s = s.slice(0, 64)
  return s
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const m = url.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  const mimeType = m[1]
  const data = m[2]
  if (!mimeType || !data) return null
  return { mimeType, data }
}

function inferMimeType(url: string): string {
  const lower = url.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.mp3')) return 'audio/mp3'
  if (lower.endsWith('.wav')) return 'audio/wav'
  return 'image/jpeg'
}

function extractContentText(content: unknown): string {
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
  return ''
}

function contentToParts(content: unknown): GeminiPart[] {
  if (content === null || content === undefined) return []
  if (typeof content === 'string') {
    return content ? [{ text: content }] : []
  }
  if (Array.isArray(content)) {
    const parts: GeminiPart[] = []
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      const it = item as Record<string, unknown>
      const type = it.type
      if (type === 'text' && typeof it.text === 'string') {
        parts.push({ text: it.text })
      } else if (
        type === 'image_url' &&
        it.image_url &&
        typeof it.image_url === 'object'
      ) {
        const urlVal = (it.image_url as Record<string, unknown>).url
        if (typeof urlVal === 'string') {
          const parsed = parseDataUrl(urlVal)
          if (parsed) {
            parts.push({
              inlineData: { mimeType: parsed.mimeType, data: parsed.data },
            })
          } else {
            parts.push({
              fileData: { fileUri: urlVal, mimeType: inferMimeType(urlVal) },
            })
          }
        }
      } else if (
        type === 'input_audio' &&
        it.input_audio &&
        typeof it.input_audio === 'object'
      ) {
        const audio = it.input_audio as Record<string, unknown>
        const data = typeof audio.data === 'string' ? audio.data : ''
        const format = typeof audio.format === 'string' ? audio.format : 'wav'
        const mimeType = format === 'mp3' ? 'audio/mp3' : `audio/${format}`
        if (data) parts.push({ inlineData: { mimeType, data } })
      } else if (type === 'file' && it.file && typeof it.file === 'object') {
        const file = it.file as Record<string, unknown>
        const fileDataRaw =
          typeof file.file_data === 'string'
            ? file.file_data
            : typeof (file as Record<string, unknown>).data === 'string'
              ? ((file as Record<string, unknown>).data as string)
              : ''
        if (fileDataRaw) {
          const parsed = parseDataUrl(fileDataRaw)
          if (parsed) {
            parts.push({
              inlineData: { mimeType: parsed.mimeType, data: parsed.data },
            })
          } else {
            parts.push({ text: fileDataRaw })
          }
        }
      } else if (typeof it.text === 'string') {
        parts.push({ text: it.text })
      }
    }
    return parts
  }
  return []
}

function convertJsonSchemaToOpenApi3(schema: unknown): unknown {
  if (schema === null || typeof schema !== 'object') {
    return { type: 'object', properties: {} }
  }
  if (Array.isArray(schema)) {
    return (schema as unknown[]).map((v) => convertJsonSchemaToOpenApi3(v))
  }
  const src = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (k === '$ref' || k === '$defs' || k === 'definitions' || k === '$schema')
      continue
    if (k === 'additionalProperties' && v === true) {
      out[k] = true
      continue
    }
    if (v !== null && typeof v === 'object') {
      out[k] = convertJsonSchemaToOpenApi3(v)
    } else {
      out[k] = v
    }
  }
  if (!out.type && out.properties) out.type = 'object'
  return out
}

function mergeConsecutiveRoles(contents: GeminiContent[]): GeminiContent[] {
  if (contents.length <= 1) return contents
  const merged: GeminiContent[] = []
  for (const cur of contents) {
    const prev = merged[merged.length - 1]
    if (prev && prev.role === cur.role) {
      prev.parts.push(...cur.parts)
    } else {
      merged.push({ role: cur.role, parts: [...cur.parts] })
    }
  }
  return merged
}

function buildTools(tools: unknown):
  | {
      functionDeclarations: {
        name: string
        description?: string
        parameters?: unknown
      }[]
    }[]
  | undefined {
  if (!Array.isArray(tools)) return undefined
  const decls: { name: string; description?: string; parameters?: unknown }[] =
    []
  for (const t of tools) {
    if (!t || typeof t !== 'object') continue
    const rec = t as Record<string, unknown>
    const fnRaw = (rec.function ?? rec) as Record<string, unknown>
    if (!fnRaw || typeof fnRaw !== 'object') continue
    const nameRaw = typeof fnRaw.name === 'string' ? fnRaw.name : undefined
    if (!nameRaw) continue
    const name = sanitizeIdentifier(nameRaw)
    const description =
      typeof fnRaw.description === 'string' ? fnRaw.description : undefined
    const paramsRaw = fnRaw.parameters ??
      fnRaw.input_schema ??
      fnRaw.inputSchema ?? { type: 'object', properties: {} }
    const parameters = convertJsonSchemaToOpenApi3(paramsRaw)
    const entry: { name: string; description?: string; parameters?: unknown } =
      { name, parameters }
    if (description !== undefined) entry.description = description
    decls.push(entry)
  }
  if (decls.length === 0) return undefined
  return [{ functionDeclarations: decls }]
}

function buildToolConfig(
  toolChoice: unknown,
): Record<string, unknown> | undefined {
  if (toolChoice === undefined) return undefined
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'none')
      return { functionCallingConfig: { mode: 'NONE' } }
    if (toolChoice === 'required')
      return { functionCallingConfig: { mode: 'ANY' } }
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  if (toolChoice && typeof toolChoice === 'object') {
    const tc = toolChoice as Record<string, unknown>
    const fn = tc.function as Record<string, unknown> | undefined
    if (tc.type === 'function' && fn && typeof fn.name === 'string') {
      return {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [sanitizeIdentifier(fn.name)],
        },
      }
    }
    return { functionCallingConfig: { mode: 'AUTO' } }
  }
  return undefined
}

function buildGenerationConfig(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const cfg: Record<string, unknown> = {}
  if (typeof body.max_tokens === 'number') cfg.maxOutputTokens = body.max_tokens
  else if (typeof body.max_completion_tokens === 'number')
    cfg.maxOutputTokens = body.max_completion_tokens
  if (typeof body.temperature === 'number') cfg.temperature = body.temperature
  if (typeof body.top_p === 'number') cfg.topP = body.top_p
  if (typeof body.top_k === 'number') cfg.topK = body.top_k

  const stopVal = body.stop
  if (typeof stopVal === 'string') cfg.stopSequences = [stopVal]
  else if (Array.isArray(stopVal)) cfg.stopSequences = stopVal
  if (Array.isArray(body.stop_sequences))
    cfg.stopSequences = body.stop_sequences
  if (Array.isArray(body.stopSequences)) cfg.stopSequences = body.stopSequences

  let thinkingBudget: number | undefined
  const thinkingRaw = body.thinking as Record<string, unknown> | undefined
  if (
    thinkingRaw &&
    typeof thinkingRaw === 'object' &&
    typeof thinkingRaw.budget_tokens === 'number'
  ) {
    thinkingBudget = thinkingRaw.budget_tokens
  } else if (typeof body.reasoning_effort === 'string') {
    const mapped = effortToGeminiBudget[body.reasoning_effort]
    if (mapped !== undefined) thinkingBudget = mapped
  } else if (body.reasoning && typeof body.reasoning === 'object') {
    const r = body.reasoning as Record<string, unknown>
    if (typeof r.effort === 'string') {
      const mapped = effortToGeminiBudget[r.effort]
      if (mapped !== undefined) thinkingBudget = mapped
    } else if (typeof r.budget_tokens === 'number') {
      thinkingBudget = r.budget_tokens
    }
  }

  if (thinkingBudget !== undefined) {
    if (thinkingBudget > 0) {
      cfg.thinkingConfig = { thinkingBudget, includeThoughts: true }
    } else {
      cfg.thinkingConfig = { thinkingBudget: 0, includeThoughts: false }
    }
  }

  return Object.keys(cfg).length > 0 ? cfg : undefined
}

export function openaiToGemini(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages)
    ? (body.messages as unknown[])
    : []

  const systemTexts: string[] = []
  const nonSystem: unknown[] = []

  for (const m of messages) {
    if (
      m &&
      typeof m === 'object' &&
      'role' in (m as Record<string, unknown>)
    ) {
      const role = (m as Record<string, unknown>).role
      if (role === 'system' || role === 'developer') {
        const txt = extractContentText((m as Record<string, unknown>).content)
        if (txt) systemTexts.push(txt)
        continue
      }
    }
    nonSystem.push(m)
  }

  let systemInstruction: { parts: { text: string }[] } | undefined
  if (systemTexts.length > 0) {
    systemInstruction = { parts: [{ text: systemTexts.join('\n\n') }] }
  }

  const tools = buildTools(body.tools)
  const toolConfig = buildToolConfig(body.tool_choice)
  const generationConfig = buildGenerationConfig(body)

  const toolIdToName = new Map<string, string>()
  for (const m of nonSystem) {
    if (m && typeof m === 'object') {
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
  }

  const rawContents: GeminiContent[] = []

  for (const m of nonSystem) {
    if (!m || typeof m !== 'object') continue
    const rec = m as Record<string, unknown>
    const roleRaw = rec.role

    if (roleRaw === 'assistant') {
      const parts: GeminiPart[] = []

      const rc = (rec.reasoning_content ?? rec.reasoning) as unknown
      if (typeof rc === 'string' && rc.length > 0) {
        parts.push({ thought: true, text: rc })
      }

      const sig =
        (rec.thoughtSignature as unknown) ??
        (rec.thought_signature as unknown) ??
        (rec.signature as unknown)
      if (typeof sig === 'string' && sig.length > 0) {
        parts.push({ thoughtSignature: sig })
      }

      parts.push(...contentToParts(rec.content))

      if (Array.isArray(rec.tool_calls)) {
        for (const tc of rec.tool_calls as unknown[]) {
          if (!tc || typeof tc !== 'object') continue
          const r = tc as Record<string, unknown>
          const fn = r.function as Record<string, unknown> | undefined
          const nameRaw =
            fn && typeof fn.name === 'string' ? fn.name : undefined
          const name = nameRaw ? sanitizeIdentifier(nameRaw) : 'unknown_tool'
          const argsStr =
            fn && typeof fn.arguments === 'string' ? fn.arguments : undefined
          let args: Record<string, unknown> = {}
          if (argsStr !== undefined) {
            const s = argsStr.trim()
            if (s) {
              try {
                const parsed = JSON.parse(s)
                if (
                  parsed &&
                  typeof parsed === 'object' &&
                  !Array.isArray(parsed)
                ) {
                  args = parsed as Record<string, unknown>
                }
              } catch {
                // keep empty args on parse failure
              }
            }
          } else if (
            fn?.arguments &&
            typeof fn.arguments === 'object' &&
            !Array.isArray(fn.arguments)
          ) {
            args = fn.arguments as Record<string, unknown>
          }

          const tcSig =
            (r.thoughtSignature as unknown) ??
            (r.thought_signature as unknown) ??
            (r.signature as unknown)
          if (typeof tcSig === 'string' && tcSig.length > 0) {
            parts.push({ thoughtSignature: tcSig })
          }

          parts.push({ functionCall: { name, args } })

          const id = typeof r.id === 'string' ? r.id : undefined
          if (id && nameRaw) toolIdToName.set(id, sanitizeIdentifier(nameRaw))
        }
      }

      if (parts.length === 0) parts.push({ text: '' })
      rawContents.push({ role: 'model', parts })
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
        rawContents.push({ role: 'user', parts: [{ text: textFallback }] })
        continue
      }

      let fnName = nameFromMap ?? explicitName ?? toolCallId ?? 'unknown_tool'
      fnName = sanitizeIdentifier(fnName)

      const rawContent = rec.content
      let response: Record<string, unknown>
      if (typeof rawContent === 'string') {
        const trimmed = rawContent.trim()
        if (
          (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
          (trimmed.startsWith('[') && trimmed.endsWith(']'))
        ) {
          try {
            const parsed = JSON.parse(trimmed)
            if (
              parsed &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed)
            ) {
              response = parsed as Record<string, unknown>
            } else {
              response = { content: rawContent }
            }
          } catch {
            response = { content: rawContent }
          }
        } else {
          response = { content: rawContent }
        }
      } else if (
        rawContent &&
        typeof rawContent === 'object' &&
        !Array.isArray(rawContent)
      ) {
        response = rawContent as Record<string, unknown>
      } else if (Array.isArray(rawContent)) {
        response = { content: JSON.stringify(rawContent) }
      } else {
        response = { content: String(rawContent ?? '') }
      }

      rawContents.push({
        role: 'user',
        parts: [{ functionResponse: { name: fnName, response } }],
      })
    } else {
      // user or other -> user
      const parts = contentToParts(rec.content)
      const finalParts = parts.length > 0 ? parts : [{ text: '' } as GeminiPart]
      rawContents.push({ role: 'user', parts: finalParts })
    }
  }

  const contents = mergeConsecutiveRoles(rawContents)

  const out: Record<string, unknown> = { contents }

  if (systemInstruction) out.systemInstruction = systemInstruction
  if (tools) out.tools = tools
  if (toolConfig) out.toolConfig = toolConfig
  if (generationConfig) out.generationConfig = generationConfig

  return out
}
