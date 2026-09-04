import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Copy, Square, Send, Zap, Activity, Clock } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  fetchModels,
  fetchChatCompletionsStream,
  postChatCompletions,
  consumeChatStream,
  getClampedInfo,
  classifyError,
  classifyNetworkError,
} from "@/lib/api";
import type { ModelEntry, ChatCompletionsUsage, ClassifiedError } from "@/lib/api";

type ViewerLine = {
  id: number;
  raw: string;
  kind: "comment" | "data" | "done" | "error" | "info";
};

function estimateClamped(maxTokens: number | undefined, model: ModelEntry | undefined): boolean {
  if (!maxTokens || !model) return false;
  const win = (model.context_length as number | undefined) ?? (model.contextLength as number | undefined) ?? 128000;
  return maxTokens > Math.max(0, win - 1024);
}

export default function Playground() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<ClassifiedError | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>("");

  const [prompt, setPrompt] = useState("Hello! Explain what lmntea-router does in one sentence.");
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState<number | undefined>(undefined);
  const [stream, setStream] = useState(true);

  const [sending, setSending] = useState(false);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);
  const [answer, setAnswer] = useState<string>("");
  const [usage, setUsage] = useState<ChatCompletionsUsage | null>(null);
  const [clamped, setClamped] = useState<{ clamped: boolean; headerValue?: string | null; clampedTo?: number } | null>(null);
  const [viewerLines, setViewerLines] = useState<ViewerLine[]>([]);
  const viewerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<ClassifiedError | null>(null);
  const [keepaliveCount, setKeepaliveCount] = useState(0);
  const [stallWarn, setStallWarn] = useState<string | null>(null);
  const lineIdRef = useRef(0);
  const startAtRef = useRef<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);

  useEffect(() => {
    if (!sending || startAtRef.current === null) return;
    const iv = window.setInterval(() => {
      if (startAtRef.current !== null) setElapsedMs(Date.now() - startAtRef.current);
    }, 200);
    return () => window.clearInterval(iv);
  }, [sending]);

  useEffect(() => {
    if (viewerRef.current) viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
  }, [viewerLines, answer]);

  const selectedModelEntry = useMemo(() => models.find((m) => m.id === selectedModel), [models, selectedModel]);
  const isClampedByInput = estimateClamped(maxTokens, selectedModelEntry) || Boolean(clamped?.clamped);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      const res = await fetchModels(signal);
      const list = res.data ?? [];
      list.sort((a, b) => {
        const pa = ((a.priceIn as number | undefined) ?? (a.pricePer1MInput as number | undefined) ?? 0) + ((a.priceOut as number | undefined) ?? (a.pricePer1MOutput as number | undefined) ?? 0);
        const pb = ((b.priceIn as number | undefined) ?? (b.pricePer1MInput as number | undefined) ?? 0) + ((b.priceOut as number | undefined) ?? (b.pricePer1MOutput as number | undefined) ?? 0);
        if (pa !== pb) return pa - pb;
        return String(a.id).localeCompare(String(b.id));
      });
      setModels(list);
      if (list.length && !selectedModel) {
        const preferred = list.find((m) => String(m.id).includes("free")) ?? list[0];
        if (preferred) setSelectedModel(String(preferred.id));
      }
    } catch (e) {
      if (e instanceof ApiError) setModelsError(e as unknown as ClassifiedError);
      else if (e instanceof DOMException && e.name === "AbortError") { /* ignore */ }
      else setModelsError(classifyNetworkError(e) as ClassifiedError);
    } finally {
      setModelsLoading(false);
    }
  }, [selectedModel]);

  useEffect(() => {
    const ctrl = new AbortController();
    loadModels(ctrl.signal);
    return () => ctrl.abort();
  }, [loadModels]);

  const appendViewer = useCallback((raw: string, kind: ViewerLine["kind"]) => {
    lineIdRef.current += 1;
    const entry: ViewerLine = { id: lineIdRef.current, raw, kind };
    setViewerLines((prev) => [...prev.slice(-299), entry]);
  }, []);

  const handleAbort = useCallback(() => {
    if (abortCtrl) {
      abortCtrl.abort();
      appendViewer(": aborted by user", "info");
      setSending(false);
      setAbortCtrl(null);
      setStallWarn(null);
    }
  }, [abortCtrl, appendViewer]);

  const handleSend = useCallback(async () => {
    if (!selectedModel) {
      setError({ kind: "validation", status: 422, title: "Select a model", description: "Pick a model before sending.", retryable: false });
      return;
    }
    if (!prompt.trim()) {
      setError({ kind: "validation", status: 422, title: "Empty prompt", description: "Prompt cannot be empty.", retryable: false });
      return;
    }

    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    setSending(true);
    setAnswer("");
    setUsage(null);
    setClamped(null);
    setError(null);
    setStallWarn(null);
    setViewerLines([]);
    setKeepaliveCount(0);
    lineIdRef.current = 0;
    startAtRef.current = Date.now();
    setElapsedMs(0);

    appendViewer("→ POST /v1/chat/completions { model: " + selectedModel + ", stream: " + String(stream) + " }", "info");

    try {
      if (stream) {
        const { response, clamped: clampedInfo } = await fetchChatCompletionsStream(
          {
            model: selectedModel,
            messages: [{ role: "user", content: prompt }],
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            temperature,
          },
          { signal: ctrl.signal },
        );
        setClamped(clampedInfo);
        if (clampedInfo.clamped) appendViewer(": clamped max_tokens → " + String(clampedInfo.headerValue ?? clampedInfo.clampedTo), "comment");
        appendViewer("← 200 text/event-stream", "info");
        const hdrClamped = getClampedInfo(response.headers);
        if (hdrClamped.clamped) setClamped(hdrClamped);

        await consumeChatStream(
          response,
          {
            stallMs: 60_000,
            onDelta: (t) => setAnswer((prev) => prev + t),
            onComment: (raw) => {
              setKeepaliveCount((c) => c + 1);
              appendViewer(raw, "comment");
            },
            onEvent: (ev) => {
              if (!ev.isComment) appendViewer(ev.raw, ev.data === "[DONE]" ? "done" : "data");
            },
            onUsage: (u) => setUsage(u),
            onError: (err) => {
              setStallWarn(err.description);
              appendViewer(": stall watchdog — " + err.description, "error");
            },
            onDone: () => appendViewer("data: [DONE]", "done"),
          },
          ctrl.signal,
        );
      } else {
        const { data, clamped: c } = await postChatCompletions(
          {
            model: selectedModel,
            messages: [{ role: "user", content: prompt }],
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            temperature,
          },
          { signal: ctrl.signal },
        );
        setClamped(c);
        const text = data.choices?.[0]?.message?.content ?? data.choices?.[0]?.delta?.content ?? "";
        setAnswer(typeof text === "string" ? text : JSON.stringify(text));
        if (data.usage) setUsage(data.usage);
        appendViewer("← 200 application/json", "info");
        appendViewer("data: " + JSON.stringify(data).slice(0, 800), "data");
        if (c.clamped) appendViewer(": clamped max_tokens → " + String(c.headerValue), "comment");
      }
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e as unknown as ClassifiedError);
        appendViewer("← " + String(e.status) + " " + e.title + ": " + e.description, "error");
      } else if (e instanceof DOMException && e.name === "AbortError") {
        appendViewer(": aborted", "info");
      } else if (e instanceof Error) {
        const statusMatch = e.message.match(/\b(401|403|413|429|5\d\d)\b/);
        if (statusMatch) {
          const code = Number(statusMatch[1]);
          const ce = classifyError(code, { message: e.message }, e.message);
          setError(ce);
          appendViewer("← " + String(ce.status) + " " + ce.title, "error");
        } else {
          const ce = classifyNetworkError(e);
          setError(ce as ClassifiedError);
          appendViewer("← network error: " + ce.description, "error");
        }
      }
    } finally {
      setSending(false);
      setAbortCtrl(null);
      if (startAtRef.current !== null) setElapsedMs(Date.now() - startAtRef.current);
    }
  }, [selectedModel, prompt, stream, maxTokens, temperature, appendViewer]);

  const handleCopyAnswer = useCallback(async () => {
    if (!answer) return;
    await navigator.clipboard.writeText(answer).catch(() => {});
  }, [answer]);

  const errorVariant = useMemo(() => {
    if (!error) return "default" as const;
    if (error.kind === "auth" || error.kind === "ssrf" || error.kind === "payload_too_large") return "destructive" as const;
    return "default" as const;
  }, [error]);

  return (
    <div className="space-y-6">
      <PageHeader title="Playground" description="Interactive chat against the router.">
        <div className="flex flex-wrap items-center gap-1.5">
          {isClampedByInput && (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 font-mono text-xs text-warning">clamped</Badge>
          )}
          {clamped?.clamped && clamped.headerValue && (
            <Badge variant="outline" className="border-warning/30 bg-warning/10 font-mono text-xs text-warning">max_tokens → {clamped.headerValue}</Badge>
          )}
          {sending && elapsedMs !== null && (
            <Badge variant="outline" className="border-border bg-background gap-1.5 font-mono text-xs tabular-nums text-muted-foreground">
              <Clock className="h-3 w-3" /> {(elapsedMs / 1000).toFixed(1)}s
            </Badge>
          )}
          {keepaliveCount > 0 && (
            <Badge variant="outline" className="border-border bg-background gap-1.5 font-mono text-xs text-muted-foreground">
              <Activity className="h-3 w-3" /> keepalive ×{keepaliveCount}
            </Badge>
          )}
          <span className="hidden font-mono text-[11px] text-muted-foreground/60 sm:inline">Hono Gateway · POST /v1/chat/completions</span>
          <Badge variant="outline" className="border-border bg-background font-mono text-xs text-muted-foreground">stream</Badge>
        </div>
      </PageHeader>

      {error && (
        <Alert variant={errorVariant}>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="flex items-center gap-2">
            {error.title}
            <Badge variant="outline" className="border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">{error.status || error.kind}</Badge>
            {error.code && <Badge variant="outline" className="border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">{error.code}</Badge>}
          </AlertTitle>
          <AlertDescription>
            {error.description}
            {error.kind === "auth" && <span className="mt-2 block text-xs text-muted-foreground">Set <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground/80">lmntea-api-key</code> in localStorage or VITE_API_KEY, then retry.</span>}
            {error.kind === "payload_too_large" && <span className="mt-2 block text-xs text-muted-foreground">Reduce prompt length or max_tokens.</span>}
            {error.kind === "rate_limit" && <span className="mt-2 block text-xs text-muted-foreground">Wait a moment then retry — rate limiter active.</span>}
            {error.kind === "ssrf" && <span className="mt-2 block text-xs text-muted-foreground">Private host blocked. Check proxy pool target is public.</span>}
          </AlertDescription>
        </Alert>
      )}

      {stallWarn && (
        <Alert variant="default" className="border-warning/30 bg-warning/10">
          <Clock className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">Stall watchdog</AlertTitle>
          <AlertDescription className="text-warning/80">{stallWarn}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
        <Card className="bg-card">
          <CardHeader className="space-y-3">
            <CardTitle className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">Request</CardTitle>
            {modelsLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : modelsError ? (
              <Alert variant="destructive" className="border-destructive/30 bg-destructive/10">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle className="text-sm">{modelsError.title}</AlertTitle>
                <AlertDescription className="text-xs">
                  {modelsError.description}
                  <Button variant="outline" size="sm" className="ml-2" onClick={() => loadModels()}>Retry</Button>
                </AlertDescription>
              </Alert>
            ) : models.length === 0 ? (
              <Empty className="border border-dashed border-border bg-background">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><Zap className="h-5 w-5" /></EmptyMedia>
                  <EmptyTitle className="text-sm">No models available</EmptyTitle>
                  <EmptyDescription className="text-xs">Check gateway /v1/models or add a provider.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                <label className="text-xs font-medium text-muted-foreground">Model · GET /v1/models</label>
                <Select value={selectedModel} onValueChange={(v: string | null) => { if (typeof v === "string") setSelectedModel(v); }}>
                  <SelectTrigger className="w-full bg-background font-mono text-sm">
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {models.map((m) => (
                      <SelectItem key={String(m.id)} value={String(m.id)} className="font-mono text-xs">
                        <span className="flex items-center gap-2">
                          <span>{String(m.id)}</span>
                          {typeof m.context_length === "number" && <span className="text-muted-foreground">{(m.context_length / 1000).toFixed(0)}k</span>}
                          {(((m.priceIn as number | undefined) ?? 0) + ((m.priceOut as number | undefined) ?? 0) === 0) && <Badge variant="outline" className="ml-1 border-live/20 bg-live/10 text-[10px] text-live">free</Badge>}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedModelEntry && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {typeof selectedModelEntry.context_length === "number" && <Badge variant="outline" className="border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">ctx {selectedModelEntry.context_length}</Badge>}
                    {typeof selectedModelEntry.max_output === "number" && <Badge variant="outline" className="border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">max {selectedModelEntry.max_output}</Badge>}
                    {Array.isArray(selectedModelEntry.supported_parameters) && selectedModelEntry.supported_parameters.length > 0 && <Badge variant="outline" className="border-border bg-background text-xs text-muted-foreground">{selectedModelEntry.supported_parameters.slice(0, 3).join(", ")}</Badge>}
                  </div>
                )}
              </div>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label htmlFor="prompt" className="text-xs font-medium text-muted-foreground">Prompt</label>
              <Textarea
                id="prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Type a message…"
                className="min-h-28 resize-y bg-background font-mono text-sm dark:bg-background"
                disabled={sending}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span className="font-mono tabular-nums">{prompt.length} chars</span>
                <span className="font-mono tabular-nums">{Math.ceil(prompt.length / 4)} est. tokens</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Max tokens (optional)</label>
                <input
                  type="number"
                  min={1}
                  max={131072}
                  placeholder="auto"
                  value={maxTokens ?? ""}
                  onChange={(e) => {
                    const v = e.target.value ? Number(e.target.value) : undefined;
                    setMaxTokens(v && Number.isFinite(v) ? v : undefined);
                  }}
                  className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
                  disabled={sending}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">Temperature</label>
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={temperature}
                  onChange={(e) => setTemperature(Number(e.target.value))}
                  className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm tabular-nums placeholder:text-muted-foreground/60 focus:border-ring focus:outline-none focus:ring-2 focus:ring-ring/40"
                  disabled={sending}
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-border bg-background px-3 py-2.5">
              <div className="flex flex-col">
                <span className="text-sm font-medium">Stream</span>
                <span className="font-mono text-[11px] text-muted-foreground/70">SSE · POST /v1/chat/completions stream:true</span>
              </div>
              <Switch checked={stream} onCheckedChange={setStream} disabled={sending} />
            </div>
            <div className="flex gap-2">
              <Button onClick={handleSend} disabled={sending || modelsLoading || !selectedModel} className="flex-1">
                <Send className="mr-2 h-4 w-4" />{sending ? "Streaming…" : "Send"}
              </Button>
              {sending && <Button variant="outline" onClick={handleAbort}><Square className="mr-2 h-3.5 w-3.5" /> Abort</Button>}
            </div>
            {isClampedByInput && (
              <Alert variant="default" className="border-warning/30 bg-warning/10 py-2">
                <AlertTitle className="text-xs text-warning">Clamped</AlertTitle>
                <AlertDescription className="text-xs text-warning/80">max_tokens will be clamped to window - overhead (4 chars/token). Badge shows applied limit.</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">Response</CardTitle>
              <div className="flex items-center gap-2">
                {usage && <Badge variant="outline" className="border-border bg-background font-mono text-xs tabular-nums text-muted-foreground">{usage.prompt_tokens} / {usage.completion_tokens} · {usage.total_tokens} tokens</Badge>}
                <Button variant="ghost" size="icon-sm" onClick={handleCopyAnswer} disabled={!answer} aria-label="Copy response"><Copy className="h-3.5 w-3.5" /></Button>
              </div>
            </CardHeader>
            <CardContent>
              {sending && !answer ? (
                <div className="space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-5/6" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              ) : answer ? (
                <div className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-sm leading-relaxed whitespace-pre-wrap break-words">
                  {answer}{sending && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-muted-foreground/70 align-middle" />}
                </div>
              ) : error ? (
                <Empty className="border border-dashed border-border bg-background py-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><AlertCircle className="h-5 w-5 text-muted-foreground" /></EmptyMedia>
                    <EmptyTitle className="text-sm">{error.title}</EmptyTitle>
                    <EmptyDescription className="text-xs">{error.description}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <Empty className="border border-dashed border-border bg-background py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><Zap className="h-5 w-5 text-muted-foreground" /></EmptyMedia>
                    <EmptyTitle className="text-sm">No response yet</EmptyTitle>
                    <EmptyDescription className="text-xs">Send a prompt to see streaming output.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
              {usage && (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="rounded-md border border-border bg-background px-3 py-2"><div className="font-mono text-[11px] text-muted-foreground/70">Prompt</div><div className="mt-0.5 font-mono text-sm font-medium tabular-nums">{usage.prompt_tokens}</div></div>
                  <div className="rounded-md border border-border bg-background px-3 py-2"><div className="font-mono text-[11px] text-muted-foreground/70">Completion</div><div className="mt-0.5 font-mono text-sm font-medium tabular-nums">{usage.completion_tokens}</div></div>
                  <div className="rounded-md border border-border bg-background px-3 py-2"><div className="font-mono text-[11px] text-muted-foreground/70">Total</div><div className="mt-0.5 font-mono text-sm font-medium tabular-nums">{usage.total_tokens}</div></div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="bg-card">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 py-3">
              <CardTitle className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
                <Activity className="h-3.5 w-3.5" /> SSE Viewer
                <Badge variant="outline" className="border-border bg-background font-mono text-[10px] normal-case tracking-normal text-muted-foreground">:keepalive pings + stall watchdog 60s</Badge>
              </CardTitle>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setViewerLines([])} disabled={viewerLines.length === 0}>Clear</Button>
            </CardHeader>
            <CardContent className="pt-0">
              <div ref={viewerRef} className="max-h-64 overflow-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-5" aria-live="polite">
                {viewerLines.length === 0 ? <span className="text-muted-foreground/60">— waiting for stream… (earlyKeepalive :keepalive every 3s after 2s grace)</span> : viewerLines.map((l) => (
                  <div key={l.id} className={l.kind === "comment" ? "text-muted-foreground/70" : l.kind === "error" ? "text-destructive" : l.kind === "done" ? "text-live" : l.kind === "info" ? "text-muted-foreground" : "text-foreground/80"}>{l.raw}</div>
                ))}
              </div>
              <div className="mt-2 flex items-center gap-2 font-mono text-[11px] text-muted-foreground/60">
                <span>earlyKeepalive 2s grace → 3s interval</span><span className="text-muted-foreground/30">·</span><span>stallWatchdog 60s</span><span className="text-muted-foreground/30">·</span><span>AbortController ready</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
