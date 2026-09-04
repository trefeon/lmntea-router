import { useEffect, useState } from "react";
import { Download, TrendingUp, Coins, Clock, Activity, AlertTriangle, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { fetchUsage, type UsageSummary, type UsagePoint, ApiError } from "@/lib/api";

const unknown = "—";

function Sparkline({ points }: { points: UsagePoint[] }) {
  const maxR = Math.max(...points.map((p) => p.requests), 1);
  const knownTokens = points.filter((p) => p.tokens !== null);
  const maxT = Math.max(...knownTokens.map((p) => p.tokens ?? 0), 1);
  const w = 760;
  const h = 120;
  const pad = 36;
  const plotW = w - pad;
  const toX = (i: number) => pad + (i / Math.max(1, points.length - 1)) * plotW;
  const toYReq = (v: number) => h - (v / maxR) * (h * 0.7) - 10;
  const toYTok = (v: number) => h - (v / maxT) * (h * 0.6) - 14;
  const reqD = points.map((p, i) => `${i === 0 ? "M" : "L"}${toX(i)},${toYReq(p.requests)}`).join(" ");
  const tokD = points.reduce((path, p, i) => p.tokens === null ? path : `${path}${path ? " L" : "M"}${toX(i)},${toYTok(p.tokens)}`, "");
  const reqArea = `${reqD} L${toX(points.length - 1)},${h - 10} L${toX(0)},${h - 10} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h + 40}`} width="100%" height="160" role="img" aria-label="Usage area chart" className="block">
      <defs>
        <linearGradient id="ug1" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--foreground)" stopOpacity=".16" /><stop offset="100%" stopColor="var(--foreground)" stopOpacity="0" /></linearGradient>
        <linearGradient id="ug2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--chart-1)" stopOpacity=".18" /><stop offset="100%" stopColor="var(--chart-1)" stopOpacity="0" /></linearGradient>
      </defs>
      <rect x={pad} y="10" width={plotW} height={h - 20} rx="6" fill="var(--background)" stroke="var(--input)" strokeDasharray="4 4" />
      <g stroke="var(--border)" strokeWidth="1"><line x1={pad} y1="40" x2={w} y2="40" /><line x1={pad} y1="70" x2={w} y2="70" /><line x1={pad} y1="100" x2={w} y2="100" /></g>
      {tokD ? <path d={tokD} fill="none" stroke="var(--chart-1)" strokeWidth="1.7" strokeLinejoin="round" /> : null}
      <path d={reqArea} fill="url(#ug1)" />
      <path d={reqD} fill="none" stroke="var(--foreground)" strokeWidth="1.8" strokeLinejoin="round" />
      <g fill="var(--muted-foreground)" fontSize="10" fontFamily="ui-monospace,monospace">
        {points.map((p, i) => {
          if (i % Math.ceil(points.length / 5) !== 0 && i !== points.length - 1) return null;
          return <text key={`${p.t}${i}`} x={toX(i)} y={h + 14} textAnchor="middle">{p.t}</text>;
        })}
      </g>
    </svg>
  );
}

export default function Usage() {
  const [period, setPeriod] = useState<"24h" | "7d" | "30d">("24h");
  const [data, setData] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setLoading(true);
    setErr(null);
    fetchUsage(period, ac.signal)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setErr(e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "Failed to load usage");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [period]);

  function exportCsv() {
    if (!data) return;
    const rows = data.byModel.map((m) => [m.model, m.req, m.tokens ?? "", m.share, m.ttftMs ?? "", m.cost ?? ""].join(",")).join("\n");
    const blob = new Blob([`model,req,tokens,share,ttftMs,cost\n${rows}`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage-${period}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) return <div className="space-y-4"><Skeleton className="h-10 w-full" /><div className="grid grid-cols-2 gap-4 lg:grid-cols-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[110px]" />)}</div><Skeleton className="h-[220px] w-full" /></div>;
  if (err && !data) return <Empty className="border border-destructive/30 bg-destructive/10"><EmptyHeader><EmptyMedia variant="icon" className="bg-destructive/15 text-destructive"><AlertTriangle className="h-4 w-4" /></EmptyMedia><EmptyTitle className="text-destructive">Failed to load usage</EmptyTitle><EmptyDescription>{err}</EmptyDescription></EmptyHeader><Button variant="outline" onClick={() => window.location.reload()}><RefreshCw className="h-4 w-4" /> Retry</Button></Empty>;
  if (!data) return null;

  const errorRate = data.requests ? ((data.errors / data.requests) * 100).toFixed(1) : "0.0";
  const successRate = (100 - Number(errorRate)).toFixed(1);
  const totalTokens = data.tokensIn !== null && data.tokensOut !== null ? data.tokensIn + data.tokensOut : null;
  const windowMinutes = period === "7d" ? 10080 : period === "30d" ? 43200 : 1440;
  const perMin = (data.requests / windowMinutes).toFixed(1);
  const hasPoints = data.points.length > 0;
  const hasTokenPoints = data.points.some((p) => p.tokens !== null);
  const peakReq = hasPoints ? data.points.reduce((m, p) => p.requests > m.requests ? p : m, data.points[0]) : null;

  return (
    <div className="space-y-6">
      <PageHeader title="Usage" description="Request metrics and gateway latency">
        <div className="inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5">{(["24h", "7d", "30d"] as const).map((p) => <button key={p} type="button" onClick={() => setPeriod(p)} className={`rounded-sm px-2.5 py-1 font-mono text-xs tabular-nums transition-colors duration-150 ${period === p ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"}`}>{p}</button>)}</div>
        <Button variant="outline" onClick={exportCsv}><Download className="h-4 w-4" /> CSV Export</Button>
      </PageHeader>
      {err ? <div className="flex items-center gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 font-mono text-xs text-warning"><AlertTriangle className="size-4 shrink-0" /> {err}</div> : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground"><Activity className="size-3.5" /> Requests</CardTitle></CardHeader><CardContent><div className="font-mono text-3xl font-semibold tabular-nums">{data.requests.toLocaleString()}</div><p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{successRate}% success · {perMin}/min avg</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground"><TrendingUp className="size-3.5" /> Tokens IN / OUT</CardTitle></CardHeader><CardContent><div className="flex items-baseline gap-1.5 font-mono text-3xl font-semibold tabular-nums">{data.tokensIn === null ? unknown : `${(data.tokensIn / 1_000_000).toFixed(1)}M`}<span className="text-sm text-muted-foreground">/ {data.tokensOut === null ? unknown : `${(data.tokensOut / 1_000_000).toFixed(1)}M`} out</span></div><p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">{totalTokens === null ? unknown : `${(totalTokens / 1_000_000).toFixed(1)}M total`} · {data.cacheHit === null ? unknown : `${Math.round(data.cacheHit * 100)}% cached`}</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground"><Coins className="size-3.5" /> Cost</CardTitle></CardHeader><CardContent><div className="font-mono text-3xl font-semibold tabular-nums">{data.cost === null ? unknown : `$${data.cost.toFixed(2)}`}</div><p className="mt-1.5 font-mono text-[11px] text-muted-foreground">{data.byModel.length} models observed</p></CardContent></Card>
        <Card><CardHeader className="pb-2"><CardTitle className="flex items-center gap-1.5 font-mono text-[11px] uppercase text-muted-foreground"><Clock className="size-3.5" /> Gateway latency</CardTitle></CardHeader><CardContent><div className="flex items-baseline gap-1.5 font-mono text-3xl font-semibold tabular-nums">{data.avgLatencyMs === null ? unknown : `${(data.avgLatencyMs / 1000).toFixed(1)}s`}</div><p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">p95 {data.p95Ms === null ? unknown : `${(data.p95Ms / 1000).toFixed(1)}s`}</p></CardContent></Card>
      </div>

      <Card className="overflow-hidden p-0"><div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"><div><h3 className="font-mono text-xs uppercase text-muted-foreground">Requests{hasTokenPoints ? " & tokens" : ""} · {period}</h3><p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{hasPoints ? `${data.points.length} samples` : "No records"}</p></div><div className="flex gap-2"><Badge variant="outline" className="gap-1.5"><span className="size-2 rounded-full bg-foreground" /> requests</Badge>{hasTokenPoints ? <Badge variant="outline" className="gap-1.5"><span className="size-2 rounded-full bg-chart-1" /> tokens</Badge> : null}</div></div>{hasPoints ? <div className="px-4 pt-4"><Sparkline points={data.points} /><div className="-mx-4 mt-4 border-t border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">peak {peakReq?.requests.toLocaleString()} requests @ {peakReq?.t}</div></div> : <Empty className="border-0 bg-background py-10"><EmptyHeader><EmptyMedia variant="icon"><TrendingUp className="h-4 w-4" /></EmptyMedia><EmptyTitle>No usage yet</EmptyTitle><EmptyDescription>Usage data will appear after the first request.</EmptyDescription></EmptyHeader></Empty>}</Card>

      <div className="grid gap-4 lg:grid-cols-[1.3fr_.7fr]"><Card className="overflow-hidden p-0"><div className="px-4 py-3"><h3 className="font-mono text-xs uppercase text-muted-foreground">Breakdown by model</h3></div><div className="overflow-auto border-y border-border"><Table className="min-w-[720px]"><TableHeader><TableRow><TableHead>Model</TableHead><TableHead className="text-right">Req</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Share</TableHead><TableHead className="text-right">Avg TTFT</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader><TableBody>{data.byModel.length === 0 ? <TableRow><TableCell colSpan={6} className="p-6 text-center font-mono text-xs text-muted-foreground">No usage yet</TableCell></TableRow> : data.byModel.map((r) => <TableRow key={r.model}><TableCell className="font-mono text-xs">{r.model}</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{r.req.toLocaleString()}</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{r.tokens === null ? unknown : r.tokens >= 1000 ? `${(r.tokens / 1000).toFixed(0)}k` : r.tokens}</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{r.share}%</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{r.ttftMs === null ? unknown : `${(r.ttftMs / 1000).toFixed(1)}s`}</TableCell><TableCell className="text-right font-mono text-xs tabular-nums">{r.cost === null ? unknown : `$${r.cost.toFixed(2)}`}</TableCell></TableRow>)}</TableBody></Table></div><div className="flex flex-wrap gap-2 px-4 py-3"><Badge variant="outline" className="font-mono text-xs">Tokens and costs when reported</Badge></div></Card><div className="grid gap-4"><Card><CardHeader className="pb-2"><CardTitle className="font-mono text-[11px] uppercase text-muted-foreground">Quick stats</CardTitle></CardHeader><CardContent className="grid gap-2"><div className="flex justify-between"><span className="font-mono text-xs text-muted-foreground">Cache hit rate</span><span className="font-mono text-sm tabular-nums">{data.cacheHit === null ? unknown : `${Math.round(data.cacheHit * 100)}%`}</span></div><div className="flex justify-between"><span className="font-mono text-xs text-muted-foreground">Error rate</span><span className="font-mono text-sm tabular-nums">{errorRate}% · {data.errors}/{data.requests.toLocaleString()}</span></div><div className="flex justify-between"><span className="font-mono text-xs text-muted-foreground">p95 latency</span><span className="font-mono text-sm tabular-nums">{data.p95Ms === null ? unknown : `${(data.p95Ms / 1000).toFixed(1)}s`}</span></div></CardContent></Card><Button variant="outline" className="w-full" onClick={exportCsv}><Download className="h-4 w-4" /> Export CSV</Button></div></div>
    </div>
  );
}
