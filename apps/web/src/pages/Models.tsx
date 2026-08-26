import { useEffect, useMemo, useState } from "react";
import { Search, RefreshCw, Download, Filter, AlertTriangle } from "lucide-react";
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Models Catalog</h1>
          <p className="font-mono text-xs text-zinc-500">Enriched via OpenRouter + Artificial Analysis · inherit model · no override</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="border-zinc-800 bg-zinc-900" onClick={doSync} disabled={syncing}><RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> Refresh</Button>
          <Button variant="outline" className="border-zinc-800 bg-zinc-900" onClick={()=> {
            const rows = filtered.map((m)=> `${m.id},${m.context_length},${m.priceIn},${m.priceOut}`).join("\n");
            const blob = new Blob([`model,context,priceIn,priceOut\n${rows}`], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a"); a.href=url; a.download="models.csv"; a.click(); URL.revokeObjectURL(url);
          }}><Download className="h-4 w-4" /> Export CSV</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge className="border-white/20 bg-white text-zinc-900">OpenRouter · Artificial Analysis</Badge>
          <span className="font-mono text-xs text-zinc-400"><span className="font-semibold text-white">{models.length} models</span> · synced {lastSync} · TTL 1h {fromMock ? "· mock fallback" : "· live"}</span>
          <Badge className={fromMock ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"}>● {fromMock ? "mock" : "live"}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-xs text-zinc-500 sm:inline">GET /v1/models · enriched</span>
          <Button size="sm" className="bg-white text-zinc-900 hover:bg-zinc-100" onClick={doSync} disabled={syncing}>{syncing ? "Syncing…" : "Sync now"}</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search model id, provider…" className="w-[220px] border-zinc-800 bg-zinc-900 pl-8" />
        </div>
        <Select value={ctxFilter} onValueChange={(v: string | null) => { if (v) setCtxFilter(v); }}><SelectTrigger className="w-[140px] border-zinc-800 bg-zinc-900"><SelectValue placeholder="Context" /></SelectTrigger><SelectContent><SelectItem value="any">Context: any</SelectItem><SelectItem value="128k">≥128k</SelectItem><SelectItem value="200k">≥200k</SelectItem><SelectItem value="1m">≥1M</SelectItem></SelectContent></Select>
        <Select value={cap} onValueChange={(v: string | null) => { if (v) setCap(v); }}><SelectTrigger className="w-[160px] border-zinc-800 bg-zinc-900"><SelectValue placeholder="Capabilities" /></SelectTrigger><SelectContent><SelectItem value="all">Capabilities: all</SelectItem><SelectItem value="tools">Tools ✓</SelectItem><SelectItem value="thinking">Thinking ✓</SelectItem><SelectItem value="images">Images ✓</SelectItem></SelectContent></Select>
        <Select value={sort} onValueChange={(v: string | null) => { if (v) setSort(v); }}><SelectTrigger className="w-[160px] border-zinc-800 bg-zinc-900"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="value">Sort: ValueScore ↓</SelectItem><SelectItem value="intelligence">Intelligence ↓</SelectItem><SelectItem value="price">Price ↑</SelectItem><SelectItem value="coding">Coding ↓</SelectItem><SelectItem value="tps">TPS ↓</SelectItem></SelectContent></Select>
        <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">supported_parameters=tools</Badge>
        <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">output_modalities=image</Badge>
        <button onClick={()=>setFreeOnly((v)=>!v)} className={`rounded-full border px-3 py-1 font-mono text-xs ${freeOnly ? "border-white bg-white text-zinc-900" : "border-zinc-800 bg-zinc-900 text-zinc-400"}`}>Free only</button>
      </div>

      {err ? <div className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 font-mono text-xs text-red-300"><AlertTriangle className="h-4 w-4" /> {err} — {err.includes("401") ? "check Bearer token" : err.includes("429") ? "rate limited" : err.includes("413") ? "payload too large" : "retry / failover"} <Button size="xs" variant="outline" className="ml-auto border-red-500/30 bg-red-500/10" onClick={()=> load()}>Retry</Button></div> : null}

      <Card className="overflow-hidden border-zinc-800 bg-zinc-900 p-0">
        <div className="overflow-auto">
          <Table className="min-w-[980px]">
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                {["Model","Context","Max-Out","Thinking","Images","Intelligence","Coding","TPS / TTFT","Worth It","ValueScore","Price /1M In·Out"].map((h)=> <TableHead key={h} className="whitespace-nowrap font-mono text-xs uppercase tracking-widest text-zinc-500">{h}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? Array.from({length:6}).map((_,i)=> (
                <TableRow key={i} className="border-zinc-800"><TableCell colSpan={11}><Skeleton className="h-6 w-full bg-zinc-800" /></TableCell></TableRow>
              )) : filtered.length===0 ? (
                <TableRow><TableCell colSpan={11} className="p-0"><Empty className="bg-zinc-950"><EmptyHeader><EmptyMedia variant="icon"><Filter className="h-4 w-4" /></EmptyMedia><EmptyTitle>No models</EmptyTitle><EmptyDescription>No models match filters — try clearing search or Free only</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>
              ) : filtered.map((m)=> (
                <TableRow key={m.id} className="border-zinc-800">
                  <TableCell><div className="font-mono text-sm font-medium">{m.id}</div><div className="font-mono text-[11px] text-zinc-500">{m.provider}</div></TableCell>
                  <TableCell className="font-mono text-xs">{formatCtx(m.context_length)}</TableCell>
                  <TableCell className="font-mono text-xs">{m.max_output ? m.max_output.toLocaleString() : "—"}</TableCell>
                  <TableCell>{m.supports_thinking ? <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">✓</Badge> : <Badge variant="outline" className="border-zinc-800 bg-zinc-950">—</Badge>}</TableCell>
                  <TableCell>{m.supports_images ? <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">✓</Badge> : <Badge variant="outline" className="border-zinc-800 bg-zinc-950">—</Badge>}</TableCell>
                  <TableCell className="whitespace-nowrap"><span className="font-mono text-xs">{m.intelligence ?? "—"}</span> {m.intelligence ? <span className="ml-1 inline-block h-1.5 w-16 overflow-hidden rounded-full bg-zinc-800 align-middle"><i className="block h-full bg-white" style={{ width: `${Math.min(100, m.intelligence)}%` }} /></span> : null}</TableCell>
                  <TableCell className="font-mono text-xs">{m.coding ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs">{m.tps ? `${m.tps} / ${m.ttftMs ? (m.ttftMs/1000).toFixed(1)+"s" : "—"}` : "— / —"}</TableCell>
                  <TableCell>{m.worth ? <Badge variant="outline" className={m.worth.toLowerCase().includes("worth") || m.worth.toLowerCase().includes("coder") ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 bg-zinc-950 text-zinc-400"}>{m.worth}</Badge> : <Badge variant="outline" className="border-zinc-800 bg-zinc-950">—</Badge>}</TableCell>
                  <TableCell><Badge variant="outline" className={m.valueScore && m.valueScore>800 ? "border-white bg-white text-zinc-900" : "border-zinc-800 bg-zinc-950"}>{m.valueScore ?? "—"}</Badge></TableCell>
                  <TableCell className="font-mono text-xs text-zinc-400">${m.priceIn ?? "—"} · ${m.priceOut ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-zinc-800 bg-zinc-950 p-3">
          <Badge variant="outline" className="border-zinc-800 bg-zinc-900 font-mono text-xs">Intelligence = AA index (0–100)</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-900 font-mono text-xs">Coding = coding sub-index</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-900 font-mono text-xs">TPS = tokens/s (TTFT → first token)</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-900 font-mono text-xs">ValueScore = intelligence / price (free=999)</Badge>
        </div>
      </Card>

      {selected ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Detail — {selected.id}</CardTitle>
              <div className="mt-2 flex flex-wrap gap-2"><Badge variant="outline" className="border-zinc-800 bg-zinc-950">context {formatCtx(selected.context_length)}</Badge><Badge variant="outline" className="border-zinc-800 bg-zinc-950">max_out {selected.max_output?.toLocaleString() ?? "—"}</Badge>{selected.supports_thinking ? <Badge className="bg-white text-zinc-900">thinking ✓</Badge> : null}{selected.supports_images ? <Badge className="bg-white text-zinc-900">images ✓</Badge> : null}<Badge variant="outline" className="border-zinc-800 bg-zinc-950">tools ✓</Badge></div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Intelligence</div><div className="mt-1 text-lg font-bold">{selected.intelligence ?? "—"}</div><div className="font-mono text-[11px] text-zinc-500">AA UnifiedSpec</div></div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Coding</div><div className="mt-1 text-lg font-bold">{selected.coding ?? "—"}</div><div className="font-mono text-[11px] text-zinc-500">SWE / LiveCodeBench</div></div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">TPS / TTFT</div><div className="mt-1 text-lg font-bold">{selected.tps ?? "—"} / {selected.ttftMs ? (selected.ttftMs/1000).toFixed(1)+"s" : "—"}</div><div className="font-mono text-[11px] text-zinc-500">p50 streaming</div></div>
              </div>
              <div className="mt-3 flex gap-2"><Button className="bg-white text-zinc-900 hover:bg-zinc-100">Add to Combo</Button><Button variant="outline" className="border-zinc-800 bg-zinc-950">View on OpenRouter →</Button></div>
            </CardContent>
          </Card>
          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Columns — UnifiedModelSpec</CardTitle></CardHeader>
            <CardContent className="font-mono text-xs leading-6 text-zinc-400">
              Maps to <span className="text-white">research/model_intelligence_artificial_analysis_spec.md</span><br />
              <span className="text-white">context</span> = n_ctx · <span className="text-white">max-out</span> = max_tokens cap<br />
              <span className="text-white">thinking</span> = reasoning budget · <span className="text-white">images</span> = output_modalities includes image<br />
              Intelligence/Coding from AA benchmark roll-up (not price).<br />
              Worth It + ValueScore computed locally — not from API.
              <div className="mt-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2"><span>Keep inherit model — no per-route override</span><Badge className="bg-white text-zinc-900">inherit ✓</Badge></div>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="flex flex-wrap justify-between gap-2 font-mono text-[11px] text-zinc-500">
        <span>Filter bar → OpenRouter query: <span className="text-zinc-400">?supported_parameters=tools&amp;output_modalities=image&amp;sort=pricing-low-to-high</span></span>
        <span>Rows {filtered.length} / {models.length}</span>
      </div>
    </div>
  );
}
