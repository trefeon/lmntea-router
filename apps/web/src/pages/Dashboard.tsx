import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Check, Copy } from "lucide-react";
import { Activity, ArrowRight, Combine, Database, RefreshCw, Server, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";
import { fetchHealth, fetchModels, MOCK_RELAYS, type Health } from "@/lib/api";
import { FirstRunReadinessCard } from "@/components/FirstRunReadinessCard";

export default function Dashboard() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);
  const [models, setModels] = useState<{ count: number; fromMock: boolean } | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const recentErrors = [
    { time: "11:58:34", model: "oc/x-preview-f-free", status: 400, msg: "max_tokens illegal [1,131072]" },
    { time: "11:56:24", model: "oc/laguna-s-2.1-free", status: 400, msg: "context 262k exceeded (603k)" },
    { time: "11:53:54", model: "oc/muse-spark…", status: 500, msg: "Internal server error" },
    { time: "11:51:02", model: "oc/x-preview-f-free", status: 504, msg: "FUNCTION_INVOCATION_TIMEOUT" },
    { time: "11:50:19", model: "oc/mimo-v2.5-free", status: 0, msg: "stream stall timeout" },
  ];

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    Promise.allSettled([fetchHealth(ac.signal), fetchModels(ac.signal)])
      .then(([h, m]) => {
        if (h.status === "fulfilled") setHealth(h.value as Health);
        else setHealthErr(h.reason instanceof Error ? h.reason.message : "health failed");
        if (m.status === "fulfilled") {
          const v = m.value as { data: unknown[]; fromMock: boolean };
          setModels({ count: (v.data as unknown[]).length, fromMock: v.fromMock });
        } else setModels({ count: 419, fromMock: true });
      })
      .finally(() => setLoading(false));
    return () => ac.abort();
  }, []);

  return (
    <div className="space-y-3">
      <FirstRunReadinessCard />

      <Card className="border-zinc-800 bg-zinc-900">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Provider Topology · OpenCode Zen</CardTitle>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-400">6 relays · Random rotation</Badge>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[68px] bg-zinc-800" />)}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
              {MOCK_RELAYS.map((r) => (
                <div key={r.id} className="rounded-xl border border-zinc-800 bg-zinc-950 p-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" />
                    <span className="font-mono text-sm font-semibold">{r.name}</span>
                    <Badge variant="outline" className="ml-auto border-zinc-800 bg-zinc-900 font-mono text-[11px] text-zinc-400">{r.latencyMs}ms</Badge>
                  </div>
                  <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{r.url}</div>
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
            <span className="font-mono text-xs text-zinc-400">25s watchdog → sibling failover (100% proxied, zero direct leakage)</span>
            <Badge className="bg-white text-zinc-900">Strict Proxy ON</Badge>
          </div>
          {healthErr ? <div className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 font-mono text-xs text-red-300">Health error: {healthErr}</div> : null}
          {health ? <div className="mt-2 font-mono text-xs text-zinc-500">/health {(health as Health).status} {(health as unknown as { latencyMs?: number }).latencyMs ? `· ${(health as unknown as { latencyMs?: number }).latencyMs}ms` : ""}</div> : null}
        </CardContent>
      </Card>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {loading ? Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[110px] bg-zinc-900" />) : (
          <>
            <Card className="border-zinc-800 bg-zinc-900">
              <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Requests (24h)</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-bold tracking-tight">14,901 <span className="text-xs font-normal text-zinc-500">· 472 errors (3.2%)</span></div>
                <div className="mt-2 flex h-7 items-center justify-center rounded-lg border border-dashed border-zinc-800 font-mono text-[11px] text-zinc-500">sparkline — success 96.8%</div>
              </CardContent>
            </Card>
            <Card className="border-zinc-800 bg-zinc-900">
              <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Tokens IN / OUT</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-bold tracking-tight">1.9M <span className="text-xs font-normal text-zinc-500">/ 0.6M</span></div>
                <div className="mt-2 flex h-7 items-center justify-center rounded-lg border border-dashed border-zinc-800 font-mono text-[11px] text-zinc-500">IN 64% cached ↻</div>
              </CardContent>
            </Card>
            <Card className="border-zinc-800 bg-zinc-900">
              <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Avg TTFT</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-bold tracking-tight">2.1s <span className="text-xs font-normal text-zinc-500">· p95 5.7s</span></div>
                <div className="mt-2 flex h-7 items-center justify-center rounded-lg border border-dashed border-zinc-800 font-mono text-[11px] text-zinc-500">keepalive 2s · watchdog 60s</div>
              </CardContent>
            </Card>
            <Card className="border-zinc-800 bg-zinc-900">
              <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Cost (est.)</CardTitle></CardHeader>
              <CardContent>
                <div className="text-xl font-bold tracking-tight">$0.00 <span className="text-xs font-normal text-zinc-500">· 8 free models</span></div>
                <div className="mt-2 flex h-7 items-center justify-center rounded-lg border border-dashed border-zinc-800 font-mono text-[11px] text-zinc-500">ValueScore 999 (free)</div>
              </CardContent>
            </Card>
          </>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.2fr_.8fr]">
        <Card className="overflow-hidden border-zinc-800 bg-zinc-900 p-0">
          <div className="flex items-center justify-between p-4">
            <h3 className="font-mono text-xs uppercase tracking-widest text-zinc-500">Recent Errors</h3>
            <Link to="/usage" className={cn(buttonVariants({ variant: "outline", size: "sm" }), "border-zinc-800 bg-zinc-950")}>View logs <ArrowRight className="h-3 w-3" /></Link>
          </div>
          <div className="overflow-auto border-t border-zinc-800">
            <Table>
              <TableHeader>
                <TableRow className="border-zinc-800 hover:bg-transparent">
                  <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Time</TableHead>
                  <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Model</TableHead>
                  <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Status</TableHead>
                  <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentErrors.map((e) => (
                  <TableRow key={e.time} className="border-zinc-800">
                    <TableCell className="font-mono text-xs">{e.time}</TableCell>
                    <TableCell className="font-mono text-xs">{e.model}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={e.status === 0 ? "border-zinc-800 bg-zinc-950 text-zinc-400" : e.status >= 500 ? "border-red-500/30 bg-red-500/10 text-red-300" : e.status === 504 ? "border-amber-500/30 bg-amber-500/10 text-amber-300" : "border-red-500/30 bg-red-500/10 text-red-300"}>{e.status === 0 ? "stall" : e.status}</Badge>
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate font-mono text-xs text-zinc-400">{e.msg}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {recentErrors.length === 0 ? (
            <Empty className="border-t border-zinc-800 bg-zinc-950">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Activity className="h-4 w-4" /></EmptyMedia>
                <EmptyTitle>No errors</EmptyTitle>
                <EmptyDescription>Recent errors will appear here</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
        </Card>

        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Quick Actions</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            <Link to="/providers" className={cn(buttonVariants({ variant: "outline" }), "justify-start border-zinc-800 bg-zinc-950")}><Server className="h-4 w-4" /> Add Provider</Link>
            <Link to="/proxy-pools" className={cn(buttonVariants({ variant: "outline" }), "justify-start border-zinc-800 bg-zinc-950")}><Activity className="h-4 w-4" /> Test Proxy Pools</Link>
            <Link to="/models" className={cn(buttonVariants({ variant: "outline" }), "justify-start border-zinc-800 bg-zinc-950")}><Database className="h-4 w-4" /> Browse {models?.count ?? 419} Models {models?.fromMock ? "(mock)" : ""}</Link>
            <Link to="/combos" className={cn(buttonVariants(), "justify-start bg-white text-zinc-900 hover:bg-zinc-100")}><Combine className="h-4 w-4" /> Create Combo</Link>
            <div className="mt-2 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
              <div className="text-xs font-semibold">lmntea-router · Hono + Bun</div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-500">
                GET /health · app.request() 2ms
                <Button variant="ghost" size="xs" onClick={() => { navigator.clipboard.writeText("http://localhost:8787/v1"); setCopied(true); setTimeout(()=>setCopied(false),1200); }}>
                  {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? "Copied" : "Copy Base URL"}
                </Button>
              </div>
            </div>
            {healthErr ? (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 font-mono text-xs text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" /> {healthErr} <Button variant="ghost" size="xs" onClick={() => location.reload()}><RefreshCw className="h-3 w-3" /> Retry</Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
