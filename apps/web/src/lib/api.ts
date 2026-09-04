/* Hono backend client — unified: WebShell mocks + UXPlayground classifier/streaming */
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ||
  (import.meta.env.VITE_HONO_URL as string | undefined) ||
  "";

const FALLBACK_BASE = "http://localhost:3000";

/** Resolve base, allowing localStorage override (lmntea-api-base wins, then lmntea_api_base, then env) */
export function getApiBase(): string {
  if (typeof window !== "undefined") {
    const stored =
      localStorage.getItem("lmntea-api-base") ||
      localStorage.getItem("lmntea_api_base");
    if (stored && stored.trim()) return stored.trim().replace(/\/$/, "");
  }
  return API_BASE.replace(/\/$/, "");
}

export function setApiBase(url: string): void {
  if (typeof window === "undefined") return;
  if (!url || !url.trim()) {
    localStorage.removeItem("lmntea-api-base");
    localStorage.removeItem("lmntea_api_base");
  } else {
    localStorage.setItem("lmntea-api-base", url.trim().replace(/\/$/, ""));
  }
}

export function getApiKey(): string {
  try {
    // support both keys for compat
    return (
      localStorage.getItem("lmntea-api-key") ||
      localStorage.getItem("lmntea_api_key") ||
      (import.meta.env.VITE_API_KEY as string | undefined) ||
      ""
    );
  } catch {
    return (import.meta.env.VITE_API_KEY as string | undefined) || "";
  }
}
export function setApiKey(v: string): void {
  try {
    if (!v) {
      localStorage.removeItem("lmntea-api-key");
      localStorage.removeItem("lmntea_api_key");
    } else {
      localStorage.setItem("lmntea-api-key", v);
      localStorage.setItem("lmntea_api_key", v);
    }
  } catch {}
}

export function getAuthHeaders(): Record<string, string> {
  const key = getApiKey();
  if (!key) return {};
  return { Authorization: `Bearer ${key}` };
}

// ---------------------------------------------------------------------------
// Error classification — covers 401 / 413 / 429 / 5xx / 403 SSRF + 400/415/422
// ---------------------------------------------------------------------------

export type ErrorKind =
  | "auth"
  | "payload_too_large"
  | "rate_limit"
  | "breaker"
  | "ssrf"
  | "validation"
  | "not_found"
  | "network"
  | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  status: number;
  title: string;
  description: string;
  code?: string;
  retryable: boolean;
  raw?: unknown;
}

export interface ApiErrorShape extends ClassifiedError {
  message: string;
}

export class ApiError extends Error implements ApiErrorShape {
  status: number;
  kind: ErrorKind;
  title: string;
  description: string;
  code?: string;
  retryable: boolean;
  raw?: unknown;
  constructor(
    message: string,
    status: number,
    code?: string,
    extra?: Partial<ClassifiedError>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? extra?.code;
    this.kind = extra?.kind ?? (status === 401 ? "auth" : status === 413 ? "payload_too_large" : status === 429 ? "rate_limit" : status === 403 ? "ssrf" : status >= 500 ? "breaker" : status === 404 ? "not_found" : status >= 400 ? "validation" : "unknown");
    this.title = extra?.title ?? message;
    this.description = extra?.description ?? message;
    this.retryable = extra?.retryable ?? (status === 429 || status >= 500);
    this.raw = extra?.raw;
    this.message = extra?.description ?? message;
  }
}

// Back-compat alias used by some pages
export const ApiHttpError = ApiError;

function errorFromStatus(status: number, body: unknown, fallbackMsg?: string): ClassifiedError {
  const bodyMsg =
    typeof body === "object" && body !== null
      ? ((body as { error?: { message?: string; code?: string; type?: string } }).error?.message ??
        (body as { message?: string }).message ??
        fallbackMsg ??
        "")
      : fallbackMsg ?? "";
  const bodyCode =
    typeof body === "object" && body !== null
      ? ((body as { error?: { code?: string } }).error?.code ??
        (body as { code?: string }).code)
      : undefined;
  const lower = String(bodyMsg).toLowerCase();

  if (
    status === 403 &&
    (lower.includes("private") ||
      lower.includes("ssrf") ||
      lower.includes("private host") ||
      lower.includes("blocked") ||
      lower.includes("internal"))
  ) {
    return {
      kind: "ssrf",
      status,
      title: "SSRF blocked — private host",
      description: bodyMsg || "Request to private/internal host was blocked by SSRF guard.",
      code: bodyCode ?? "SSRF_BLOCKED",
      retryable: false,
      raw: body,
    };
  }
  if (status === 401 || (status === 403 && lower.includes("auth"))) {
    return {
      kind: "auth",
      status: 401,
      title: "Invalid API key",
      description: bodyMsg || "Authorization failed. Check Authorization: Bearer sk-* header and AUTH_TOKENS on the gateway.",
      code: bodyCode ?? "UNAUTHORIZED",
      retryable: false,
      raw: body,
    };
  }
  if (status === 413) {
    return {
      kind: "payload_too_large",
      status,
      title: "Body limit exceeded",
      description: bodyMsg || "Payload Too Large. Reduce prompt/context or max_tokens. Gateway bodyLimit is ~10MB default.",
      code: bodyCode ?? "PAYLOAD_TOO_LARGE",
      retryable: false,
      raw: body,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limit",
      status,
      title: "Rate limited",
      description: bodyMsg || "Too many requests. Back off and retry — upstream or gateway rate limiter triggered.",
      code: bodyCode ?? "RATE_LIMITED",
      retryable: true,
      raw: body,
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      kind: "breaker",
      status,
      title: "Upstream unavailable",
      description: bodyMsg || `Gateway or upstream returned ${status}. Circuit breaker may be open — retry via sibling relay.`,
      code: bodyCode ?? "SERVER_ERROR",
      retryable: true,
      raw: body,
    };
  }
  if (status === 404) {
    return {
      kind: "not_found",
      status,
      title: "Not found",
      description: bodyMsg || "Resource not found.",
      code: bodyCode ?? "NOT_FOUND",
      retryable: false,
      raw: body,
    };
  }
  if (status === 400 || status === 415 || status === 422) {
    return {
      kind: "validation",
      status,
      title: status === 415 ? "Unsupported Media Type" : status === 422 ? "Validation error" : "Bad request",
      description: bodyMsg || (status === 415 ? "Content-Type must be application/json" : "Invalid request parameters."),
      code: bodyCode ?? "INVALID_REQUEST",
      retryable: false,
      raw: body,
    };
  }
  return {
    kind: "unknown",
    status,
    title: `Request failed (${status})`,
    description: bodyMsg || fallbackMsg || "Unknown error.",
    code: bodyCode,
    retryable: status >= 500,
    raw: body,
  };
}

/** Classify by status + optional body. Back-compat: classifyError(429) → "RATE_LIMIT" string is handled separately */
export function classifyError(status: number, body?: unknown, fallbackMsg?: string): ClassifiedError {
  return errorFromStatus(status, body, fallbackMsg);
}

/** Legacy string classifier for simple badge mapping (kept for WebShell pages) */
export function classifyErrorString(status: number): string {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 413) return "PAYLOAD";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "5XX";
  if (status >= 400) return `${status}`;
  return "NET";
}

export function classifyNetworkError(err: unknown): ClassifiedError {
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const lower = String(msg).toLowerCase();
  if (lower.includes("abort") || lower.includes("aborted")) {
    return { kind: "unknown", status: 0, title: "Request aborted", description: "The request was cancelled.", retryable: false, raw: err };
  }
  return {
    kind: "network",
    status: 0,
    title: "Network error",
    description: String(msg) || "Failed to reach gateway. Check API base URL (VITE_API_BASE) and that Hono is running on :8787 or :3000.",
    retryable: true,
    raw: err,
  };
}

export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  if (e instanceof ApiError && e.title === "Request aborted") return true;
  if (e instanceof Error && /abort/i.test(e.message)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Low-level fetch
// ---------------------------------------------------------------------------

type FetchOpts = RequestInit & { timeoutMs?: number; apiBase?: string; noAuth?: boolean };

async function fetchWithAuth(path: string, opts: FetchOpts = {}): Promise<Response> {
  const key = getApiKey();
  const base = (opts.apiBase ?? getApiBase()).replace(/\/$/, "");
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((opts.headers as Record<string, string>) || {}),
  };
  if (!opts.noAuth && key) headers["Authorization"] = `Bearer ${key}`;
  const controller = new AbortController();
  const t = opts.timeoutMs ?? 25000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // only set timeout if caller didn't provide a signal; otherwise respect caller's lifetime
  const signal = opts.signal ?? controller.signal;
  if (!opts.signal) timer = setTimeout(() => controller.abort(), t);
  try {
    const res = await fetch(url, { ...opts, headers, signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T>(path: string, opts: FetchOpts = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetchWithAuth(path, opts);
  } catch (e) {
    throw new ApiError(classifyNetworkError(e).description, 0, undefined, classifyNetworkError(e));
  }
  if (!res.ok) {
    let msg = res.statusText;
    let body: unknown = undefined;
    try {
      const text = await res.text();
      try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
      const j = body as { error?: { message?: string; code?: string }; message?: string };
      msg = j?.error?.message || (j as { error?: string })?.error || j?.message || msg;
    } catch {}
    const ce = classifyError(res.status, body, msg);
    throw new ApiError(ce.description, res.status, ce.code, ce);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type Health = {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  version?: string;
  uptime?: number;
};

export type HealthResponse = Health;

export async function fetchHealth(signal?: AbortSignal): Promise<Health> {
  // /health is no-auth
  try {
    return await fetchJson<Health>("/health", { signal, timeoutMs: 8000, noAuth: true });
  } catch (err) {
    // fallback base retry (8787 -> 3000)
    if (getApiBase() === API_BASE.replace(/\/$/, "")) {
      try {
        return await fetchJson<Health>("/health", { signal, timeoutMs: 8000, noAuth: true, apiBase: FALLBACK_BASE });
      } catch {}
    }
    if (isAbortError(err)) throw err;
    throw new ApiError("Health check failed", 0, undefined, { kind: "network", status: 0, title: "Network error", description: "Gateway unreachable", retryable: true } as ClassifiedError);
  }
}

export async function fetchHealthLive(signal?: AbortSignal): Promise<Health> {
  return fetchJson<Health>("/health/live", { signal, timeoutMs: 8000, noAuth: true });
}

export const getHealth = fetchHealth;

// ---------------------------------------------------------------------------
// Models (with mock fallback for offline dev)
// ---------------------------------------------------------------------------

export type Model = {
  id: string;
  provider?: string;
  context_length?: number;
  max_output?: number;
  supports_tools?: boolean;
  supports_thinking?: boolean;
  supports_images?: boolean;
  intelligence?: number;
  coding?: number;
  tps?: number;
  ttftMs?: number;
  valueScore?: number;
  priceIn?: number;
  priceOut?: number;
  worth?: string;
};

/** Compatibility: Playground expects ModelEntry with richer fields */
export type ModelEntry = Model & {
  // enriched aliases
  contextLength?: number;
  maxCompletionTokens?: number;
  pricePer1MInput?: number;
  pricePer1MOutput?: number;
  intelligence_index?: number | null;
  coding_index?: number | null;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string; input?: string; output?: string };
  [k: string]: unknown;
};

export interface ModelsResponse {
  object: string;
  data: ModelEntry[];
  last_synced?: string | null;
  total?: number;
}

const MOCK_MODELS: Model[] = [
  { id: "oc/muse-spark-1.2-free", provider: "opencode", context_length: 131072, max_output: 16384, supports_thinking: true, intelligence: 68.2, coding: 71.4, tps: 84, ttftMs: 1900, valueScore: 999, priceIn: 0, priceOut: 0, worth: "Worth It" },
  { id: "oc/x-preview-f-free", provider: "opencode", context_length: 262144, max_output: 131072, supports_thinking: true, supports_images: true, intelligence: 72.1, coding: 76.8, tps: 61, ttftMs: 2400, valueScore: 998, priceIn: 0, priceOut: 0, worth: "Worth It" },
  { id: "oc/laguna-s-2.1-free", provider: "opencode", context_length: 262144, max_output: 65536, supports_thinking: true, intelligence: 64.5, coding: 66, tps: 52, ttftMs: 3100, valueScore: 995, priceIn: 0, priceOut: 0, worth: "Good" },
  { id: "oc/mimo-v2.5-free", provider: "opencode", context_length: 131072, max_output: 16384, supports_images: true, intelligence: 58.3, coding: 59.1, tps: 47, ttftMs: 1700, valueScore: 991, priceIn: 0, priceOut: 0, worth: "Worth It" },
  { id: "openrouter/auto", provider: "openrouter", context_length: 200000, max_output: 32768, supports_thinking: true, supports_images: true, intelligence: 61, coding: 62.2, valueScore: 420, priceIn: 1.2, priceOut: 5 },
  { id: "anthropic/claude-4.1-opus", provider: "anthropic", context_length: 200000, max_output: 64000, supports_thinking: true, supports_images: true, intelligence: 78.4, coding: 80.1, tps: 38, ttftMs: 2800, valueScore: 180, priceIn: 15, priceOut: 75, worth: "pricey" },
  { id: "deepseek/deepseek-v3.2", provider: "deepseek", context_length: 164000, max_output: 32768, supports_thinking: true, intelligence: 70.2, coding: 74.5, tps: 72, ttftMs: 1400, valueScore: 840, priceIn: 0.27, priceOut: 1.1, worth: "Worth It" },
  { id: "qwen/qwen3-coder-480b", provider: "qwen", context_length: 262144, max_output: 65536, supports_thinking: true, intelligence: 66.8, coding: 78.9, tps: 44, ttftMs: 3600, valueScore: 760, priceIn: 0.45, priceOut: 1.8, worth: "Coder pick" },
];

export async function fetchModels(signal?: AbortSignal): Promise<{ data: ModelEntry[]; fromMock: boolean }> {
  try {
    const res = await fetchJson<{ data: ModelEntry[] } | ModelEntry[]>("/v1/models", { signal, timeoutMs: 8000 });
    const arr = Array.isArray(res) ? res : (res as { data: ModelEntry[] }).data || [];
    if (!arr.length) throw new Error("empty");
    // enrich: map context_length etc to aliases if missing
    const enriched = (arr as ModelEntry[]).map((m) => ({
      ...m,
      // backend /v1/models returns OpenAI shape (owned_by) — normalize to provider
      provider:
        m.provider ??
        (m as Model & { owned_by?: string }).owned_by ??
        (String(m.id).includes("/") ? String(m.id).split("/")[0] : undefined),
      context_length: (m.context_length as number | undefined) ?? (m.contextLength as number | undefined) ?? 128000,
      contextLength: (m.contextLength as number | undefined) ?? (m.context_length as number | undefined),
      max_output: (m.max_output as number | undefined) ?? (m.maxCompletionTokens as number | undefined),
      maxCompletionTokens: (m.maxCompletionTokens as number | undefined) ?? (m.max_output as number | undefined),
      // price compat
      priceIn: (m.priceIn as number | undefined) ?? (m.pricePer1MInput as number | undefined),
      priceOut: (m.priceOut as number | undefined) ?? (m.pricePer1MOutput as number | undefined),
    }));
    enriched.sort((a, b) => {
      const pa = ((a.priceIn as number | undefined) ?? 0) + ((a.priceOut as number | undefined) ?? 0);
      const pb = ((b.priceIn as number | undefined) ?? 0) + ((b.priceOut as number | undefined) ?? 0);
      if (pa !== pb) return pa - pb;
      return String(a.id).localeCompare(String(b.id));
    });
    return { data: enriched, fromMock: false };
  } catch {
    // try fallback base
    if (getApiBase() === API_BASE.replace(/\/$/, "")) {
      try {
        const res2 = await fetchJson<{ data: ModelEntry[] } | ModelEntry[]>("/v1/models", { signal, timeoutMs: 8000, apiBase: FALLBACK_BASE });
        const arr2 = Array.isArray(res2) ? res2 : (res2 as { data: ModelEntry[] }).data || [];
        if (arr2.length) return { data: arr2 as ModelEntry[], fromMock: false };
      } catch {}
    }
    return { data: MOCK_MODELS as unknown as ModelEntry[], fromMock: true };
  }
}

export const getModels = fetchModels;

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export type UsagePoint = { t: string; requests: number; tokens: number | null };
export type UsageSummary = {
  requests: number;
  errors: number;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  avgLatencyMs: number | null;
  avgTtftMs: number | null;
  p95Ms: number | null;
  cacheHit: number | null;
  points: UsagePoint[];
  byModel: {
    model: string;
    req: number;
    tokens: number | null;
    share: number;
    ttftMs: number | null;
    cost: number | null;
  }[];
};

export async function fetchUsage(period: "24h" | "7d" | "30d", signal?: AbortSignal): Promise<UsageSummary> {
  const result = await fetchJson<UsageSummary>(`/v1/usage?period=${period}`, { signal });
  if (!result || typeof result.requests !== "number" || !Array.isArray(result.points) || !Array.isArray(result.byModel)) {
    throw new Error("Invalid usage response");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Chat completions — types + clamped header + streaming
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionsRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  [k: string]: unknown;
}

export interface ChatCompletionsUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message?: { role: string; content: string };
  delta?: { content?: string; role?: string };
  finish_reason?: string | null;
}

export interface ChatCompletionsResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: ChatCompletionsUsage | null;
}

export interface ClampedInfo {
  clamped: boolean;
  requested?: number;
  clampedTo?: number;
  headerValue?: string | null;
}

export function getClampedInfo(headers: Headers): ClampedInfo {
  const hv =
    headers.get("x-clamped-max-tokens") ??
    headers.get("x-clamped-max_tokens") ??
    headers.get("x-normalized-max-tokens") ??
    headers.get("x-normalized-max_tokens") ??
    headers.get("x-max-tokens-clamped");
  if (!hv) return { clamped: false, headerValue: null };
  const n = Number(hv);
  return { clamped: true, headerValue: hv, clampedTo: Number.isFinite(n) ? n : undefined };
}

export async function postChatCompletions(
  body: ChatCompletionsRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<{ data: ChatCompletionsResponse; headers: Headers; clamped: ClampedInfo }> {
  let res: Response;
  try {
    res = await fetchWithAuth("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...body, stream: false }),
      signal: opts.signal,
    });
  } catch (e) {
    const ce = classifyNetworkError(e);
    throw new ApiError(ce.description, 0, ce.code, ce);
  }
  const clamped = getClampedInfo(res.headers);
  const text = await res.text();
  let json: unknown = undefined;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
  if (!res.ok) {
    const ce = classifyError(res.status, json, res.statusText);
    throw new ApiError(ce.description, res.status, ce.code, ce);
  }
  return { data: json as ChatCompletionsResponse, headers: res.headers, clamped };
}

export async function fetchChatCompletionsStream(
  body: ChatCompletionsRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<{ response: Response; clamped: ClampedInfo }> {
  let res: Response;
  try {
    res = await fetchWithAuth("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ ...body, stream: true }),
      headers: { Accept: "text/event-stream" },
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new ApiError("Stream aborted by user.", 0, undefined, { kind: "unknown", status: 0, title: "Request aborted", description: "Stream aborted by user.", retryable: false } as ClassifiedError);
    }
    const ce = classifyNetworkError(e);
    throw new ApiError(ce.description, 0, ce.code, ce);
  }
  const clamped = getClampedInfo(res.headers);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let json: unknown = undefined;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { message: text }; }
    const ce = classifyError(res.status, json, res.statusText);
    throw new ApiError(ce.description, res.status, ce.code, ce);
  }
  return { response: res, clamped };
}

// keep legacy name
export const streamChatCompletionsLegacy = fetchChatCompletionsStream;

/** Legacy helper: stream with onChunk callback (WebShell uses this) */
export async function streamChatCompletions(
  body: unknown,
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchChatCompletionsStream(body as ChatCompletionsRequest, { signal });
  await consumeChatStream(res.response, { onDelta: onChunk, stallMs: 60_000 }, signal);
}

// ---------------------------------------------------------------------------
// SSE helpers (earlyKeepalive + stallWatchdog mirrors src/streaming/*)
// ---------------------------------------------------------------------------

export interface SSEEvent {
  data: string;
  json?: unknown;
  isComment: boolean;
  raw: string;
}

export function parseSSEBuffer(buffer: string): { events: SSEEvent[]; remainder: string } {
  const events: SSEEvent[] = [];
  const endsWithNewline = buffer.endsWith("\n");
  const parts = buffer.split("\n");
  const remainder = endsWithNewline ? "" : (parts[parts.length - 1] ?? "");
  const lines = endsWithNewline ? parts.slice(0, -1) : parts.slice(0, -1);
  for (const line of lines) {
    if (line === "") continue;
    if (line.startsWith(":")) { events.push({ data: "", isComment: true, raw: line }); continue; }
    if (line.startsWith("data: ")) {
      const d = line.slice(6);
      if (d === "[DONE]") { events.push({ data: "[DONE]", isComment: false, raw: line }); continue; }
      let j: unknown = undefined;
      try { j = JSON.parse(d); } catch {}
      events.push({ data: d, json: j, isComment: false, raw: line });
      continue;
    }
    if (line.startsWith("data:")) {
      const d = line.slice(5).trimStart();
      let j: unknown = undefined;
      try { j = JSON.parse(d); } catch {}
      events.push({ data: d, json: j, isComment: false, raw: line });
      continue;
    }
    events.push({ data: line, isComment: false, raw: line });
  }
  return { events, remainder };
}

export interface StreamCallbacks {
  onDelta?: (text: string) => void;
  onEvent?: (ev: SSEEvent) => void;
  onComment?: (raw: string) => void;
  onUsage?: (usage: ChatCompletionsUsage) => void;
  onDone?: () => void;
  onError?: (err: ClassifiedError) => void;
  stallMs?: number;
}

export async function consumeChatStream(
  response: Response,
  cbs: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const stallMs = cbs.stallMs ?? 60_000;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");
  const decoder = new TextDecoder();
  let buffer = "";
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const resetWatchdog = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      const err: ClassifiedError = { kind: "breaker", status: 504, title: "Stream stall", description: `No data for ${stallMs / 1000}s — stall watchdog triggered (60s).`, retryable: true };
      cbs.onError?.(err);
      try { reader.cancel("stall watchdog"); } catch {}
    }, stallMs);
  };
  resetWatchdog();
  const onAbort = () => {
    clearTimeout(watchdog);
    try { reader.cancel("aborted"); } catch {}
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetWatchdog();
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (trimmed === "") continue;
        if (trimmed.startsWith(":")) {
          cbs.onComment?.(trimmed);
          cbs.onEvent?.({ data: "", isComment: true, raw: trimmed });
          continue;
        }
        if (trimmed.startsWith("data: ")) {
          const d = trimmed.slice(6);
          const ev: SSEEvent = { data: d, isComment: false, raw: trimmed };
          if (d === "[DONE]") { cbs.onEvent?.(ev); cbs.onDone?.(); continue; }
          let j: unknown = undefined;
          try { j = JSON.parse(d); ev.json = j; } catch {}
          cbs.onEvent?.(ev);
          if (j && typeof j === "object") {
            const choices = (j as { choices?: Array<{ delta?: { content?: string }; text?: string; message?: { content?: string } }> }).choices;
            if (choices && choices[0]) {
              const c = choices[0];
              const deltaText = c.delta?.content ?? (c as { text?: string }).text ?? c.message?.content ?? "";
              if (deltaText) cbs.onDelta?.(deltaText);
              const usage = (j as { usage?: ChatCompletionsUsage }).usage;
              if (usage && typeof usage.total_tokens === "number") cbs.onUsage?.(usage);
            } else {
              const usage = (j as { usage?: ChatCompletionsUsage }).usage;
              if (usage) cbs.onUsage?.(usage);
            }
          }
          continue;
        }
        if (trimmed.startsWith("data:")) {
          const d = trimmed.slice(5).trimStart();
          const ev: SSEEvent = { data: d, isComment: false, raw: trimmed };
          cbs.onEvent?.(ev);
          continue;
        }
        cbs.onEvent?.({ data: trimmed, isComment: false, raw: trimmed });
      }
    }
    if (buffer.trim()) {
      const t = buffer.trim();
      if (t.startsWith(":")) cbs.onComment?.(t);
    }
    cbs.onDone?.();
  } finally {
    clearTimeout(watchdog);
    signal?.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Mock providers / relays / combos (for WireframePages offline dev)
// ---------------------------------------------------------------------------

export type Provider = {
  id: string;
  name: string;
  type: string;
  status: "connected" | "error" | "idle" | "disabled";
  errorCode?: string;
  errorMsg?: string;
  models?: string[];
  iconBg?: string;
};

export const MOCK_PROVIDERS: Provider[] = [
  { id: "opencode", name: "OpenCode Zen", type: "opencode · OAuth", status: "connected", models: ["oc/muse-spark-1.2", "oc/x-preview-f-free"], iconBg: "linear-gradient(135deg,#09090b,#27272a)" },
  { id: "codex", name: "Codex", type: "codex · OAuth", status: "connected", models: ["codex/gpt-5"], iconBg: "#0a0a0a" },
  { id: "claude", name: "Claude", type: "anthropic · API Key", status: "connected", models: ["anthropic/claude-opus-4"], iconBg: "#18181b" },
  { id: "openai-compatible", name: "OpenAI Compatible", type: "openai-compatible · Compatible", status: "connected", models: ["custom baseUrl"], iconBg: "#18181b" },
  { id: "gemini", name: "Gemini", type: "gemini · API Key", status: "error", errorCode: "AUTH", errorMsg: "401 invalid api key · 3m ago", iconBg: "#18181b" },
  { id: "deepseek", name: "DeepSeek", type: "deepseek · API Key", status: "error", errorCode: "429", errorMsg: "upstream_rate_limited · 429 · 12m ago", iconBg: "#18181b" },
  { id: "kimi", name: "Kimi", type: "kimi · API Key", status: "error", errorCode: "5XX", errorMsg: "upstream_unavailable · 500 · 26m ago", iconBg: "#18181b" },
  { id: "volcengine", name: "Volcengine", type: "volcengine · API Key", status: "disabled", errorMsg: "No connections · paused", iconBg: "#27272a" },
];

export type Relay = { id: string; name: string; url: string; type: string; latencyMs: number; status: number; strict: boolean; lastCheck: string };
export const MOCK_RELAYS: Relay[] = [
  { id: "trefeon", name: "trefeon", url: "trefeon-7r9gingdf…vercel.app/api/relay", type: "Vercel", latencyMs: 12, status: 200, strict: true, lastCheck: "2m ago" },
  { id: "hermes", name: "hermes", url: "hermes-5lp4…vercel.app/api/relay", type: "Vercel", latencyMs: 18, status: 200, strict: true, lastCheck: "2m ago" },
  { id: "feoni", name: "feoni", url: "feoni-q5nm…vercel.app/api/relay", type: "Vercel", latencyMs: 14, status: 200, strict: true, lastCheck: "2m ago" },
  { id: "verokes", name: "verokes", url: "verokes-2xf…vercel.app/api/relay", type: "Vercel", latencyMs: 16, status: 200, strict: true, lastCheck: "3m ago" },
  { id: "axetant", name: "axetant", url: "axetant-noj…vercel.app/api/relay", type: "Vercel", latencyMs: 21, status: 200, strict: true, lastCheck: "3m ago" },
  { id: "raxtant", name: "raxtant", url: "raxtant-5fro…vercel.app/api/relay", type: "Vercel", latencyMs: 13, status: 200, strict: true, lastCheck: "2m ago" },
];

export type Combo = {
  id: string;
  name: string;
  strategy: "fallback" | "p2c" | "cost-optimized";
  models: string[];
  health: "healthy" | "degraded" | "idle";
};

export const MOCK_COMBOS: Combo[] = [
  { id: "aether-fallback-8", name: "Aether", strategy: "fallback", models: ["oc/x-preview-f-free","oc/muse-spark-1.2-free","oc/mimo-v2.5-free","oc/laguna-s-2.1-free","oc/qwen3-8b-free","oc/gemini-2.0-flash-free","oc/deepseek-v3.2","deepseek/deepseek-v3.2"], health: "healthy" },
  { id: "flash-p2c-3", name: "Flash", strategy: "p2c", models: ["oc/muse-spark-1.2-free","oc/mimo-v2.5-free","oc/x-preview-f-free"], health: "healthy" },
  { id: "cheap-cost-opt-4", name: "Cheap", strategy: "cost-optimized", models: ["qwen/qwen3-coder-480b","deepseek/deepseek-v3.2","oc/laguna-s-2.1-free","anthropic/claude-4.1-opus"], health: "degraded" },
  { id: "vision-fallback-2", name: "Vision", strategy: "fallback", models: ["oc/x-preview-f-free","oc/gemini-2.0-flash-free"], health: "idle" },
];
