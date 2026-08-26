import { useEffect, useState } from "react";
import { Download, TrendingUp, Coins, Clock, Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fetchUsage, type UsageSummary, ApiError } from "@/lib/api";

function Sparkline({ points }: { points: { t: string; requests: number; tokens: number }[] }) {
  // normalize to SVG 0..760 x 0..120
  const maxR = Math.max(...points.map((p)=>p.requests), 1);
  const maxT = Math.max(...points.map((p)=>p.tokens), 1);
  const w = 760, h = 120;
  const pad = 36;
  const plotW = w - pad;
  const toX = (i: number) => pad + (i / Math.max(1, points.length-1)) * plotW;
  const toYReq = (v: number) => h - (v/maxR)* (h*0.7) - 10;
  const toYTok = (v: number) => h - (v/maxT)* (h*0.6) - 14;
  const reqD = points.map((p,i)=> `${i===0?"M":"L"}${toX(i)},${toYReq(p.requests)}`).join(" ");
  const tokD = points.map((p,i)=> `${i===0?"M":"L"}${toX(i)},${toYTok(p.tokens)}`).join(" ");
  const reqArea = `${reqD} L${toX(points.length-1)},${h-10} L${toX(0)},${h-10} Z`;
  const tokArea = `${tokD} L${toX(points.length-1)},${h-10} L${toX(0)},${h-10} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h+40}`} width="100%" height="160" role="img" aria-label="Usage area chart" className="block">
      <defs>
        <linearGradient id="ug1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#ffffff" stopOpacity=".28"/><stop offset="100%" stopColor="#ffffff" stopOpacity="0"/></linearGradient>
        <linearGradient id="ug2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22c55e" stopOpacity=".22"/><stop offset="100%" stopColor="#22c55e" stopOpacity="0"/></linearGradient>
      </defs>
      <rect x={pad} y="10" width={plotW} height={h-20} rx="10" fill="#09090b" stroke="#27272a" strokeDasharray="5 5" />
      <text x={w/2} y="18" textAnchor="middle" fill="#3f3f46" fontSize="10" fontFamily="ui-monospace,monospace" letterSpacing=".08em">CHART — SVG sparkline</text>
      <g stroke="#1f1f23" strokeWidth="1">
        <line x1={pad} y1="40" x2={w} y2="40"/><line x1={pad} y1="70" x2={w} y2="70"/><line x1={pad} y1="100" x2={w} y2="100"/>
      </g>
      <path d={tokArea} fill="url(#ug2)" />
      <path d={tokD} fill="none" stroke="#22c55e" strokeWidth="1.7" strokeLinejoin="round" />
      <path d={reqArea} fill="url(#ug1)" />
      <path d={reqD} fill="none" stroke="#ffffff" strokeWidth="1.8" strokeLinejoin="round" />
      <g fill="#71717a" fontSize="10" fontFamily="ui-monospace,monospace">
        {points.map((p,i)=> {
          if (i % Math.ceil(points.length/5) !==0 && i !== points.length-1) return null;
          return <text key={p.t+i} x={toX(i)} y={h+14} textAnchor="middle">{p.t}</text>;
        })}
      </g>
    </svg>
  );
}

export default function Usage() {
  const [period, setPeriod] = useState<"24h"|"7d"|"30d">("24h");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [fromMock, setFromMock] = useState(false);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setErr(null);
    fetchUsage(period, ac.signal)
      .then((r)=> { setData(r.data); setFromMock(r.fromMock); })
      .catch((e)=>{
        const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "failed";
        setErr(msg);
      })
      .finally(()=> setLoading(false));
    return () => ac.abort();
  }, [period]);

  function exportCsv() {
    if (!data) return;
    const rows = data.byModel.map((m)=> `${m.model},${m.req},${m.tokens},${m.share},${m.ttftMs??""},${m.cost}`).join("\n");
    const csv = `model,req,tokens,share,ttftMs,cost\n${rows}`;
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href=url; a.download=`usage-${period}.csv`; a.click(); URL.revokeObjectURL(url);
  }

  if (loading) {
    return <div className="space-y-3"><Skeleton className="h-10 w-full bg-zinc-900" /><div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-[110px] bg-zinc-900" />)}</div><Skeleton className="h-[220px] w-full bg-zinc-900" /></div>;
  }

  if (err && !data) {
    return (
      <div className="space-y-3">
        <Empty className="border border-red-500/30 bg-red-500/10">
          <EmptyHeader><EmptyMedia variant="icon"><AlertTriangle className="h-4 w-4 text-red-300" /></EmptyMedia><EmptyTitle className="text-red-100">Failed to load usage</EmptyTitle><EmptyDescription className="text-red-300">{err} — {err.includes("401") ? "check Bearer token" : err.includes("429") ? "rate limited" : err.includes("413") ? "payload too large" : "server error, showing mock fallback on retry"}</EmptyDescription></EmptyHeader>
          <Button variant="outline" className="border-red-500/30 bg-red-500/10 text-red-100" onClick={()=> location.reload()}><RefreshCw className="h-4 w-4" /> Retry</Button>
        </Empty>
      </div>
    );
  }

  if (!data) return null;

  const errorRate = ((data.errors / Math.max(1,data.requests))*100).toFixed(1);
  const totalTokens = (data.tokensIn + data.tokensOut);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Usage / Analytics</h1>
          <p className="font-mono text-xs text-zinc-500">Requests · Tokens IN/OUT · Cost USD · TTFT · breakdown by model {fromMock ? "· mock fallback" : ""}</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-full border border-zinc-800 bg-zinc-900 p-1">
            {(["24h","7d","30d"] as const).map((p)=> (
              <button key={p} onClick={()=>setPeriod(p)} className={`rounded-full px-3 py-1 font-mono text-xs ${period===p ? "bg-white text-zinc-900" : "text-zinc-400 hover:text-white"}`}>{p}</button>
            ))}
          </div>
          <Button variant="outline" className="border-zinc-800 bg-zinc-900" onClick={exportCsv}><Download className="h-4 w-4" /> CSV Export</Button>
        </div>
      </div>

      {err ? <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs text-amber-200"><AlertTriangle className="h-4 w-4" /> {err}</div> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-zinc-500"><Activity className="h-3.5 w-3.5" /> Requests</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold tracking-tight">{data.requests.toLocaleString()} <span className="text-xs font-normal text-zinc-500">· {data.errors} err {errorRate}%</span></div>
            <div className="mt-1 font-mono text-[11px] text-zinc-400">96.8% success · 14.3 req/min avg</div>
            <div className="mt-2 flex gap-2"><Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">▲ 12% vs 7d</Badge><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">p95 { (data.p95Ms/1000).toFixed(1)}s</Badge></div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-zinc-500"><TrendingUp className="h-3.5 w-3.5" /> Tokens IN / OUT</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold tracking-tight">{(data.tokensIn/1_000_000).toFixed(1)}M <span className="text-xs font-normal text-zinc-500">/ {(data.tokensOut/1_000_000).toFixed(1)}M</span></div>
            <div className="mt-1 font-mono text-[11px] text-zinc-400">{(totalTokens/1_000_000).toFixed(1)}M total · {Math.round(data.cacheHit*100)}% cached ↻ · 18k avg ctx</div>
            <div className="mt-2 flex items-center gap-2"><span className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800"><i className="block h-full bg-white" style={{ width: `${data.cacheHit*100}%` }} /></span><span className="font-mono text-[11px] text-zinc-500">cached</span></div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-zinc-500"><Coins className="h-3.5 w-3.5" /> Cost (est.)</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold tracking-tight">${data.cost.toFixed(2)} <span className="text-xs font-normal text-zinc-500">· 8 free models</span></div>
            <div className="mt-1 font-mono text-[11px] text-zinc-400">ValueScore 999 · $0 / 1M fallback</div>
            <div className="mt-2"><Badge className="bg-white text-zinc-900">Free tier · $0</Badge></div>
          </CardContent>
        </Card>
        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-xs uppercase tracking-widest text-zinc-500"><Clock className="h-3.5 w-3.5" /> Avg TTFT</CardTitle></CardHeader>
          <CardContent>
            <div className="text-xl font-bold tracking-tight">{(data.avgTtftMs/1000).toFixed(1)}s <span className="text-xs font-normal text-zinc-500">· p95 {(data.p95Ms/1000).toFixed(1)}s</span></div>
            <div className="mt-1 font-mono text-[11px] text-zinc-400">keepalive 2s · watchdog 60s · stalls 5</div>
            <div className="mt-2"><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">TTFT to first token</Badge></div>
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden border-zinc-800 bg-zinc-900 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 p-4">
          <div><h3 className="font-mono text-xs uppercase tracking-widest text-zinc-500">Requests & Tokens — {period}</h3><p className="font-mono text-[11px] text-zinc-500">area chart placeholder · real charts via uPlot / chart.js later · SVG sparkline proves layout</p></div>
          <div className="flex gap-2"><Badge variant="outline" className="gap-1.5 border-zinc-800 bg-zinc-950"><span className="h-2 w-2 rounded-full bg-white" /> requests</Badge><Badge variant="outline" className="gap-1.5 border-zinc-800 bg-zinc-950"><span className="h-2 w-2 rounded-full bg-emerald-500" /> tokens</Badge></div>
        </div>
        <div className="p-3">
          <Sparkline points={data.points.length ? data.points : [{t:"00:00",requests:20,tokens:5000},{t:"06:00",requests:88,tokens:15400},{t:"12:00",requests:143,tokens:28100},{t:"18:00",requests:112,tokens:21400},{t:"now",requests:98,tokens:18200}]} />
          <div className="mt-1 flex flex-wrap justify-between gap-2 font-mono text-[11px] text-zinc-500"><span>Peak 14.3 req/min @ 14:20 · trough 1.2/min @ 04:10</span><span>Real impl: GET /api/usage?period={period} → uPlot area chart {fromMock ? "(mock fallback)" : ""}</span></div>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[1.3fr_.7fr]">
        <Card className="overflow-hidden border-zinc-800 bg-zinc-900 p-0">
          <div className="flex items-center justify-between p-4"><h3 className="font-mono text-xs uppercase tracking-widest text-zinc-500">Breakdown by model</h3><Button variant="outline" size="sm" className="border-zinc-800 bg-zinc-950">Browse models →</Button></div>
          <div className="overflow-auto border-y border-zinc-800">
            <Table className="min-w-[720px]">
              <TableHeader><TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Model</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-zinc-500">Req</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-zinc-500">Tokens</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-zinc-500">Share</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-zinc-500">Avg TTFT</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-zinc-500">Cost</TableHead>
              </TableRow></TableHeader>
              <TableBody>
                {data.byModel.length===0 ? <TableRow><TableCell colSpan={6} className="p-0"><Empty className="bg-zinc-950"><EmptyHeader><EmptyMedia variant="icon"><Activity className="h-4 w-4" /></EmptyMedia><EmptyTitle>No usage yet</EmptyTitle><EmptyDescription>Usage breakdown will appear after first requests</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>
                : data.byModel.map((r)=> (
                  <TableRow key={r.model} className="border-zinc-800">
                    <TableCell className="font-mono text-xs">{r.model}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.req.toLocaleString()}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.tokens >= 1000 ? `${(r.tokens/1000).toFixed(0)}k` : r.tokens}</TableCell>
                    <TableCell className="text-right"><span className="mr-1 inline-block h-1.5 w-20 overflow-hidden rounded-full bg-zinc-800 align-middle"><i className="block h-full bg-white" style={{ width: `${r.share}%` }} /></span><span className="font-mono text-xs">{r.share}%</span></TableCell>
                    <TableCell className="text-right font-mono text-xs">{r.ttftMs ? `${(r.ttftMs/1000).toFixed(1)}s` : "—"}</TableCell>
                    <TableCell className="text-right font-mono text-xs">${r.cost.toFixed(2)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex flex-wrap gap-2 p-3">
            <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">Model → filtered Models view</Badge>
            <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">Tokens = IN+OUT</Badge>
            <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">Cost est. via /api/costs</Badge>
          </div>
        </Card>

        <div className="grid gap-3">
          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Period & Export</CardTitle></CardHeader>
            <CardContent className="grid gap-2">
              <div className="flex gap-2">
                {(["24h","7d","30d"] as const).map((p)=> <Button key={p} size="sm" variant={period===p ? "default" : "outline"} className={period===p ? "bg-white text-zinc-900 hover:bg-zinc-100" : "border-zinc-800 bg-zinc-950"} onClick={()=>setPeriod(p)}>{p}</Button>)}
                <Button size="sm" variant="outline" className="border-zinc-800 bg-zinc-950">Custom…</Button>
              </div>
              <Button variant="outline" className="w-full border-zinc-800 bg-zinc-950" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV — breakdown</Button>
              <Button variant="outline" className="w-full border-zinc-800 bg-zinc-950" onClick={exportCsv}><Download className="h-4 w-4" /> Export JSON — raw events</Button>
              <div className="font-mono text-[11px] text-zinc-500">GET /api/usage?period={period} · GET /api/costs/budget</div>
            </CardContent>
          </Card>
          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Quick stats</CardTitle></CardHeader>
            <CardContent className="grid gap-2">
              <div className="flex items-center justify-between"><span className="font-mono text-xs text-zinc-400">Cache hit rate</span><span className="font-mono text-sm font-bold">{Math.round(data.cacheHit*100)}% ↻</span></div>
              <div className="flex items-center justify-between"><span className="font-mono text-xs text-zinc-400">Error rate</span><span className="font-mono text-sm font-bold text-red-300">{errorRate}% · {data.errors}/{data.requests.toLocaleString()}</span></div>
              <div className="flex items-center justify-between"><span className="font-mono text-xs text-zinc-400">p95 latency</span><span className="font-mono text-sm font-bold">{(data.p95Ms/1000).toFixed(1)}s</span></div>
              <div className="flex items-center justify-between"><span className="font-mono text-xs text-zinc-400">Stalls (25s wd)</span><span className="font-mono text-sm font-bold">5</span></div>
              <div className="mt-2 flex flex-wrap gap-2"><Badge variant="outline" className="border-zinc-800 bg-zinc-950">Logs →</Badge><Badge variant="outline" className="border-zinc-800 bg-zinc-950">Analytics →</Badge><Badge variant="outline" className="border-zinc-800 bg-zinc-950">Costs →</Badge></div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
