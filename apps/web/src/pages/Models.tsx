import { useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, Download, Filter, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fetchModels, type Model, ApiError } from "@/lib/api";

function formatCtx(n?: number) {
  if (!n) return "—";
  if (n >= 1000000) return `${(n/1000000).toFixed(n%1000000===0?0:1)}M`;
  if (n >= 1000) return `${Math.round(n/1000)}k`;
  return `${n}`;
}

export default function Models() {
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [fromMock, setFromMock] = useState(false);
  const [q, setQ] = useState("");
  const [ctxFilter, setCtxFilter] = useState("any");
  const [cap, setCap] = useState("all");
  const [sort, setSort] = useState("value");
  const [freeOnly, setFreeOnly] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("2m ago");
  const [syncing, setSyncing] = useState(false);

  async function load(signal?: AbortSignal) {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetchModels(signal);
      setModels(res.data);
      setFromMock(res.fromMock);
      setLastSync("now");
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "failed";
      setErr(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, []);

  async function doSync() {
    setSyncing(true);
    const ac = new AbortController();
    setTimeout(()=> ac.abort(), 8000);
    await load(ac.signal);
    setSyncing(false);
  }

  const filtered = useMemo(() => {
    let out = [...models];
    if (q) {
      const qq = q.toLowerCase();
      out = out.filter((m) => m.id.toLowerCase().includes(qq) || (m.provider||"").toLowerCase().includes(qq));
    }
    if (ctxFilter !== "any") {
      const thr = ctxFilter === "128k" ? 128*1024 : ctxFilter === "200k" ? 200*1024 : 1024*1024;
      out = out.filter((m) => (m.context_length||0) >= thr);
    }
    if (cap === "tools") out = out.filter((m)=> m.supports_tools !== false);
    else if (cap === "thinking") out = out.filter((m)=> m.supports_thinking);
    else if (cap === "images") out = out.filter((m)=> m.supports_images);
    if (freeOnly) out = out.filter((m)=> (m.priceIn||0)===0 && (m.priceOut||0)===0);
    if (sort === "value") out.sort((a,b)=> (b.valueScore||0)-(a.valueScore||0));
    else if (sort === "intelligence") out.sort((a,b)=> (b.intelligence||0)-(a.intelligence||0));
    else if (sort === "price") out.sort((a,b)=> (a.priceIn||0)-(b.priceIn||0));
    else if (sort === "coding") out.sort((a,b)=> (b.coding||0)-(a.coding||0));
    else if (sort === "tps") out.sort((a,b)=> (b.tps||0)-(a.tps||0));
    return out;
  }, [models, q, ctxFilter, cap, sort, freeOnly]);

  const selected = filtered[1] || filtered[0];

  const numericCols: Record<number, true> = { 1: true, 2: true, 5: true, 6: true, 7: true, 9: true, 10: true };

  return (
    <div className="space-y-3">
      <PageHeader title="Models" description="Enriched via OpenRouter + Artificial Analysis · inherit model · no override">
        <Button variant="outline" onClick={doSync} disabled={syncing}><RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> Refresh</Button>
        <Button variant="outline" onClick={()=> {
          const rows = filtered.map((m)=> `${m.id},${m.context_length},${m.priceIn},${m.priceOut}`).join("\n");
          const blob = new Blob([`model,context,priceIn,priceOut\n${rows}`], { type: "text/csv" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a"); a.href=url; a.download="models.csv"; a.click(); URL.revokeObjectURL(url);
        }}><Download className="h-4 w-4" /> Export CSV</Button>
      </PageHeader>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge>OpenRouter · Artificial Analysis</Badge>
          <span className="font-mono text-xs text-muted-foreground"><span className="font-semibold text-foreground tabular-nums">{models.length} models</span> · synced {lastSync} · TTL 1h {fromMock ? "· mock fallback" : "· live"}</span>
          <Badge variant="outline" className={fromMock ? "bg-warning/10 text-warning" : "bg-live/10 text-live"}>● {fromMock ? "mock" : "live"}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">GET /v1/models · enriched</span>
          <Button size="sm" onClick={doSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search model id, provider…" className="w-[220px] pl-8" />
        </div>
        <Select value={ctxFilter} onValueChange={(v: string | null) => { if (v) setCtxFilter(v); }}><SelectTrigger className="w-[140px]"><SelectValue placeholder="Context" /></SelectTrigger><SelectContent><SelectItem value="any">Context: any</SelectItem><SelectItem value="128k">≥128k</SelectItem><SelectItem value="200k">≥200k</SelectItem><SelectItem value="1m">≥1M</SelectItem></SelectContent></Select>
        <Select value={cap} onValueChange={(v: string | null) => { if (v) setCap(v); }}><SelectTrigger className="w-[160px]"><SelectValue placeholder="Capabilities" /></SelectTrigger><SelectContent><SelectItem value="all">Capabilities: all</SelectItem><SelectItem value="tools">Tools ✓</SelectItem><SelectItem value="thinking">Thinking ✓</SelectItem><SelectItem value="images">Images ✓</SelectItem></SelectContent></Select>
        <Select value={sort} onValueChange={(v: string | null) => { if (v) setSort(v); }}><SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="value">Sort: ValueScore ↓</SelectItem><SelectItem value="intelligence">Intelligence ↓</SelectItem><SelectItem value="price">Price ↑</SelectItem><SelectItem value="coding">Coding ↓</SelectItem><SelectItem value="tps">TPS ↓</SelectItem></SelectContent></Select>
        <Badge variant="outline" className="font-mono text-xs">supported_parameters=tools</Badge>
        <Badge variant="outline" className="font-mono text-xs">output_modalities=image</Badge>
        <button onClick={()=>setFreeOnly((v)=>!v)} className={`inline-flex h-7 items-center rounded-lg border px-3 font-mono text-xs transition-colors ${freeOnly ? "border-primary bg-primary text-primary-foreground" : "border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"}`}>Free only</button>
      </div>

      {err ? <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 font-mono text-xs text-destructive"><AlertTriangle className="h-4 w-4" /> {err} — {err.includes("401") ? "check Bearer token" : err.includes("429") ? "rate limited" : err.includes("413") ? "payload too large" : "retry / failover"} <Button size="xs" variant="destructive" className="ml-auto" onClick={()=> load()}>Retry</Button></div> : null}

      <Card className="overflow-hidden p-0">
        <div className="overflow-auto">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {["Model","Context","Max-Out","Thinking","Images","Intelligence","Coding","TPS / TTFT","Worth It","ValueScore","Price /1M In·Out"].map((h,i)=> <TableHead key={h} className={`whitespace-nowrap font-mono text-xs uppercase tracking-widest text-muted-foreground ${numericCols[i] ? "text-right" : ""}`}>{h}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({length:6}).map((_,i)=> (
                <TableRow key={i}><TableCell colSpan={11}><Skeleton className="h-6 w-full" /></TableCell></TableRow>
              )) : filtered.length===0 ? (
                <TableRow><TableCell colSpan={11} className="p-0"><Empty className="border border-dashed bg-background"><EmptyHeader><EmptyMedia variant="icon"><Filter className="h-4 w-4" /></EmptyMedia><EmptyTitle>No models</EmptyTitle><EmptyDescription>No models match filters — try clearing search or Free only</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>
              ) : filtered.map((m)=> (
                <TableRow key={m.id}>
                  <TableCell><div className="font-mono text-sm font-medium">{m.id}</div><div className="font-mono text-[11px] text-muted-foreground">{m.provider}</div></TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{formatCtx(m.context_length)}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{m.max_output ? m.max_output.toLocaleString() : "—"}</TableCell>
                  <TableCell>{m.supports_thinking ? <Badge variant="outline" className="bg-live/10 text-live">✓</Badge> : <Badge variant="outline">—</Badge>}</TableCell>
                  <TableCell>{m.supports_images ? <Badge variant="outline" className="bg-live/10 text-live">✓</Badge> : <Badge variant="outline">—</Badge>}</TableCell>
                  <TableCell className="whitespace-nowrap"><div className="flex items-center justify-end gap-2"><span className="font-mono text-xs tabular-nums">{m.intelligence ?? "—"}</span> {m.intelligence ? <span className="inline-block h-1.5 w-16 overflow-hidden rounded-sm bg-muted align-middle"><i className="block h-full bg-foreground" style={{ width: `${Math.min(100, m.intelligence)}%` }} /></span> : null}</div></TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{m.coding ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums">{m.tps ? `${m.tps} / ${m.ttftMs ? (m.ttftMs/1000).toFixed(1)+"s" : "—"}` : "— / —"}</TableCell>
                  <TableCell>{m.worth ? <Badge variant="outline" className={m.worth.toLowerCase().includes("worth") || m.worth.toLowerCase().includes("coder") ? "bg-live/10 text-live" : "text-muted-foreground"}>{m.worth}</Badge> : <Badge variant="outline">—</Badge>}</TableCell>
                  <TableCell className="text-right">{m.valueScore && m.valueScore>800 ? <Badge className="font-mono tabular-nums">{m.valueScore}</Badge> : <Badge variant="outline" className="font-mono tabular-nums text-muted-foreground">{m.valueScore ?? "—"}</Badge>}</TableCell>
                  <TableCell className="text-right font-mono text-xs tabular-nums text-muted-foreground">${m.priceIn ?? "—"} · ${m.priceOut ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap gap-2 border-t bg-background p-3">
          <Badge variant="outline" className="font-mono text-xs">Intelligence = AA index (0–100)</Badge>
          <Badge variant="outline" className="font-mono text-xs">Coding = coding sub-index</Badge>
          <Badge variant="outline" className="font-mono text-xs">TPS = tokens/s (TTFT → first token)</Badge>
          <Badge variant="outline" className="font-mono text-xs">ValueScore = intelligence / price (free=999)</Badge>
        </div>
      </Card>

      {selected ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Detail — {selected.id}</CardTitle>
              <div className="mt-2 flex flex-wrap gap-2"><Badge variant="outline">context {formatCtx(selected.context_length)}</Badge><Badge variant="outline">max_out {selected.max_output?.toLocaleString() ?? "—"}</Badge>{selected.supports_thinking ? <Badge>thinking ✓</Badge> : null}{selected.supports_images ? <Badge>images ✓</Badge> : null}<Badge>tools ✓</Badge></div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-lg border bg-background p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Intelligence</div><div className="mt-1 font-mono text-lg font-bold tabular-nums">{selected.intelligence ?? "—"}</div><div className="font-mono text-[11px] text-muted-foreground">AA UnifiedSpec</div></div>
                <div className="rounded-lg border bg-background p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">Coding</div><div className="mt-1 font-mono text-lg font-bold tabular-nums">{selected.coding ?? "—"}</div><div className="font-mono text-[11px] text-muted-foreground">SWE / LiveCodeBench</div></div>
                <div className="rounded-lg border bg-background p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">TPS / TTFT</div><div className="mt-1 font-mono text-lg font-bold tabular-nums">{selected.tps ?? "—"} / {selected.ttftMs ? (selected.ttftMs/1000).toFixed(1)+"s" : "—"}</div><div className="font-mono text-[11px] text-muted-foreground">p50 streaming</div></div>
              </div>
              <div className="mt-3 flex gap-2"><Button>Add to Combo</Button><Button variant="outline">View on OpenRouter →</Button></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Columns — UnifiedModelSpec</CardTitle></CardHeader>
            <CardContent className="font-mono text-xs leading-6 text-muted-foreground">
              Maps to <span className="text-foreground">research/model_intelligence_artificial_analysis_spec.md</span><br />
              <span className="text-foreground">context</span> = n_ctx · <span className="text-foreground">max-out</span> = max_tokens cap<br />
              <span className="text-foreground">thinking</span> = reasoning budget · <span className="text-foreground">images</span> = output_modalities includes image<br />
              Intelligence/Coding from AA benchmark roll-up (not price).<br />
              Worth It + ValueScore computed locally — not from API.
              <div className="mt-3 flex items-center justify-between rounded-lg border bg-background px-3 py-2"><span>Keep inherit model — no per-route override</span><Badge>inherit ✓</Badge></div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-muted-foreground">
        <span>Filter bar → OpenRouter query: <span className="text-foreground/80">?supported_parameters=tools&amp;output_modalities=image&amp;sort=pricing-low-to-high</span></span>
        <span className="tabular-nums">Rows {filtered.length} / {models.length}</span>
      </div>
    </div>
  );
}
