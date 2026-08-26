import { useEffect, useState } from "react";
import { GripVertical, X, Plus, Save, Copy, Trash2, Play, ChevronUp, ChevronDown, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { MOCK_COMBOS, type Combo, fetchHealth, ApiError } from "@/lib/api";

function strategyClass(s: Combo["strategy"]) {
  if (s === "fallback") return "border-zinc-700 bg-zinc-800 text-white";
  if (s === "p2c") return "border-red-500/30 bg-red-500/10 text-red-300";
  return "border-amber-500/30 bg-amber-500/10 text-amber-300";
}

export default function Combos() {
  const [loading, setLoading] = useState(true);
  const [combos, setCombos] = useState<Combo[]>([]);
  const [activeId, setActiveId] = useState<string>("aether-fallback-8");
  const [strategy, setStrategy] = useState<Combo["strategy"]>("fallback");
  const [stack, setStack] = useState<string[]>(MOCK_COMBOS[0].models);
  const [handoff, setHandoff] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [playPrompt, setPlayPrompt] = useState("Explain fallback routing in one sentence.");
  const [playResp, setPlayResp] = useState<string | null>(null);
  const [playLoading, setPlayLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      if (ac.signal.aborted) return;
      setCombos(MOCK_COMBOS);
      const a = MOCK_COMBOS.find((c)=>c.id===activeId) || MOCK_COMBOS[0];
      setStack(a.models);
      setStrategy(a.strategy);
      setLoading(false);
    }, 400);
    fetchHealth(ac.signal).catch((e)=>{
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "health failed";
      setErr(msg);
    });
    return () => { clearTimeout(t); ac.abort(); };
  }, [activeId]);

  function move(idx: number, dir: -1 | 1) {
    setStack((prev) => {
      const n = [...prev];
      const j = idx + dir;
      if (j < 0 || j >= n.length) return prev;
      const tmp = n[idx];
      n[idx] = n[j];
      n[j] = tmp;
      return n;
    });
  }

  async function runPlayground() {
    setPlayLoading(true);
    setPlayResp(null);
    setErr(null);
    // mock streaming: show fallback behavior, with 25s watchdog note
    await new Promise((r)=>setTimeout(r, 900));
    if (Math.random() < 0.12) {
      setErr("429 Rate limited — will ROTATE + backoff to next model");
      setPlayResp(null);
    } else {
      setPlayResp("Fallback tries models 1→N, failing over on 5xx/stall with context handoff and 25s watchdog to sibling relay.");
    }
    setPlayLoading(false);
  }

  const active = combos.find((c)=>c.id===activeId) || combos[0];

  if (loading) return <div className="space-y-3"><Skeleton className="h-10 w-full bg-zinc-900" /><Skeleton className="h-[300px] w-full bg-zinc-900" /></div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Combos</h1>
          <p className="font-mono text-xs text-zinc-500">Strategy: fallback · p2c · cost-optimized · inherit model · routing via router/combo.ts</p>
        </div>
        <div className="flex gap-2"><Button variant="outline" className="border-zinc-800 bg-zinc-900">Import</Button><Button className="bg-white text-zinc-900 hover:bg-zinc-100"><Plus className="h-4 w-4" /> New Combo</Button></div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2">
        <span className="font-mono text-xs text-zinc-400">Inherited model resolution — combo inherits dashboard model selector · no per-combo override</span><Badge className="bg-white text-zinc-900">inherit ✓</Badge>
      </div>

      {err ? <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs text-amber-200"><AlertTriangle className="h-4 w-4" /> {err}</div> : null}

      <Card className="overflow-hidden border-zinc-800 bg-zinc-900 p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 p-4">
          <h3 className="font-mono text-xs uppercase tracking-widest text-zinc-500">All combos · {combos.length}</h3>
          <div className="flex items-center gap-2"><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">GET /api/combos</Badge><Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">2 healthy · 1 degraded · 1 idle</Badge></div>
        </div>
        <div className="overflow-auto border-y border-zinc-800">
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow className="border-zinc-800 hover:bg-transparent">
                <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Name</TableHead>
                <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Strategy</TableHead>
                <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Models (ordered)</TableHead>
                <TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Health</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {combos.length===0 ? <TableRow><TableCell colSpan={5} className="p-0"><Empty className="bg-zinc-950"><EmptyHeader><EmptyMedia variant="icon"><Plus className="h-4 w-4" /></EmptyMedia><EmptyTitle>No combos</EmptyTitle><EmptyDescription>Create your first combo to start routing</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>
              : combos.map((c)=> (
                <TableRow key={c.id} className={`border-zinc-800 ${activeId===c.id ? "bg-zinc-950" : ""}`}>
                  <TableCell><div className="font-semibold">{c.name}</div><div className="font-mono text-[11px] text-zinc-500">{c.id} {c.id===activeId ? "· default" : ""}</div></TableCell>
                  <TableCell><Badge variant="outline" className={`font-mono text-[11px] uppercase ${strategyClass(c.strategy)}`}>{c.strategy}</Badge></TableCell>
                  <TableCell>
                    <div className="flex max-w-[520px] flex-wrap gap-1.5">
                      {c.models.map((m,i)=> (
                        <span key={m+i} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-800 bg-zinc-950 px-2.5 py-1 font-mono text-[11px] text-zinc-400"><span className={`h-1.5 w-1.5 rounded-full ${c.health==="healthy" ? "bg-emerald-500" : c.health==="degraded" ? "bg-amber-500" : "bg-zinc-600"}`} />{m}</span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    {c.health==="healthy" ? <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">● healthy</Badge> : c.health==="degraded" ? <Badge className="border-amber-500/30 bg-amber-500/10 text-amber-300">◐ degraded</Badge> : <Badge variant="outline" className="border-zinc-800 bg-zinc-950">○ idle</Badge>}
                  </TableCell>
                  <TableCell><Button size="xs" className={activeId===c.id ? "bg-white text-zinc-900 hover:bg-zinc-100" : "bg-zinc-950 text-zinc-300 hover:bg-zinc-800"} variant={activeId===c.id ? "default" : "outline"} onClick={()=>setActiveId(c.id)}>Edit</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap gap-2 p-3">
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">fallback = try 1→N until success</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">p2c = power-of-two-choices latency race</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">cost-optimized = ValueScore sort</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">Health dots = last /health probe</Badge>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
        <Card className="border-zinc-800 bg-zinc-900">
          <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Editor — {active?.name} ({strategy} · {stack.length} models)</CardTitle><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">drag to reorder</Badge></CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-zinc-400">Strategy</span>
              <Select value={strategy} onValueChange={(v)=> setStrategy(v as Combo["strategy"])}>
                <SelectTrigger className="w-[260px] border-zinc-800 bg-zinc-950"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="fallback">fallback — sequential failover</SelectItem><SelectItem value="p2c">p2c — power-of-two-choices</SelectItem><SelectItem value="cost-optimized">cost-optimized — cheapest first</SelectItem></SelectContent>
              </Select>
              <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">router/combo.ts</Badge>
            </div>

            <div className="mt-3 rounded-xl border border-dashed border-zinc-800 bg-zinc-950 p-3">
              <div className="mb-2 font-mono text-[11px] uppercase tracking-widest text-zinc-500">Ordered model stack — drag ⋮⋮ to reorder</div>
              <div className="grid gap-1.5">
                {stack.map((m, i)=> (
                  <div key={m+i} className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-2 py-2">
                    <GripVertical className="h-3.5 w-3.5 shrink-0 text-zinc-600" />
                    <span className={`h-1.5 w-1.5 rounded-full ${i < 4 ? "bg-emerald-500" : i===4 ? "bg-amber-500" : "bg-zinc-600"}`} />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs">{i+1}. {m}</span>
                    <Badge variant="outline" className="hidden border-zinc-800 bg-zinc-950 font-mono text-[11px] sm:inline-flex">{i===0 ? "262k · thinking ✓" : i===1 ? "131k · 84 TPS" : i===2 ? "128k · images ✓" : i===3 ? "262k" : i===4 ? "32k · degraded" : i===5 ? "1M" : i===6 ? "164k" : "paid fallback"}</Badge>
                    <Button size="icon-xs" variant="ghost" onClick={()=> move(i,-1)} disabled={i===0}><ChevronUp className="h-3 w-3" /></Button>
                    <Button size="icon-xs" variant="ghost" onClick={()=> move(i,1)} disabled={i===stack.length-1}><ChevronDown className="h-3 w-3" /></Button>
                    <Button size="icon-xs" variant="ghost" onClick={()=> setStack((prev)=> prev.filter((_,idx)=> idx!==i))}><X className="h-3 w-3" /></Button>
                  </div>
                ))}
              </div>
              <Button variant="outline" className="mt-2 w-full border-zinc-800 bg-zinc-900"><Plus className="h-4 w-4" /> Add model from catalog →</Button>
            </div>

            <div className="mt-3 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
              <div><div className="text-sm font-medium">Context handoff</div><div className="font-mono text-[11px] text-zinc-500">Pass truncated history to next model on failover</div></div>
              <Switch checked={handoff} onCheckedChange={setHandoff} />
            </div>
            <div className="mt-2 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2">
              <div><div className="text-sm font-medium">Inherit model</div><div className="font-mono text-[11px] text-zinc-500">No override — use topbar selector</div></div>
              <Badge className="bg-white text-zinc-900">inherit ✓</Badge>
            </div>

            <div className="mt-3 flex gap-2"><Button className="bg-white text-zinc-900 hover:bg-zinc-100"><Save className="h-4 w-4" /> Save combo</Button><Button variant="outline" className="border-zinc-800 bg-zinc-950"><Copy className="h-4 w-4" /> Duplicate</Button><Button variant="outline" className="border-red-500/30 bg-red-500/10 text-red-300"><Trash2 className="h-4 w-4" /> Delete</Button></div>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Error classification matrix</CardTitle><p className="font-mono text-[11px] text-zinc-500">Visible in editor so routing decisions are auditable</p></CardHeader>
            <CardContent>
              <div className="overflow-hidden rounded-xl border border-zinc-800">
                <Table>
                  <TableHeader><TableRow className="border-zinc-800 bg-zinc-950 hover:bg-zinc-950"><TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Status</TableHead><TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Action</TableHead><TableHead className="font-mono text-xs uppercase tracking-widest text-zinc-500">Note</TableHead></TableRow></TableHeader>
                  <TableBody>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-300">400</Badge></TableCell><TableCell className="font-bold text-red-300">REJECT_IMMEDIATE</TableCell><TableCell className="font-mono text-xs text-zinc-500">bad request — do not retry</TableCell></TableRow>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-300">401 · 403</Badge></TableCell><TableCell className="font-bold text-amber-300">ROTATE</TableCell><TableCell className="font-mono text-xs text-zinc-500">auth → next relay/model</TableCell></TableRow>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-300">429</Badge></TableCell><TableCell className="font-bold text-amber-300">ROTATE + backoff</TableCell><TableCell className="font-mono text-xs text-zinc-500">rate limit</TableCell></TableRow>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-red-500/30 bg-red-500/10 text-red-300">5xx · 504</Badge></TableCell><TableCell className="font-bold text-white">FAILOVER</TableCell><TableCell className="font-mono text-xs text-zinc-500">→ next model in combo</TableCell></TableRow>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-zinc-800 bg-zinc-950">stall</Badge></TableCell><TableCell className="font-bold text-white">FAILOVER</TableCell><TableCell className="font-mono text-xs text-zinc-500">stream stall 25s</TableCell></TableRow>
                    <TableRow className="border-zinc-800"><TableCell><Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-300">3 in 60s</Badge></TableCell><TableCell className="font-bold">CIRCUIT_BREAK</TableCell><TableCell className="font-mono text-xs text-zinc-500">cool-down 60s</TableCell></TableRow>
                  </TableBody>
                </Table>
              </div>
              <div className="mt-3 flex flex-wrap gap-2"><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">watchdog 25s → sibling</Badge><Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">keepalive 2s</Badge><Badge className="bg-white text-zinc-900">strict proxy ON</Badge></div>
            </CardContent>
          </Card>

          <Card className="border-zinc-800 bg-zinc-900">
            <CardHeader className="pb-2"><CardTitle className="font-mono text-xs uppercase tracking-widest text-zinc-500">Playground — quick test</CardTitle></CardHeader>
            <CardContent className="grid gap-2">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Prompt</div><textarea value={playPrompt} onChange={(e)=>setPlayPrompt(e.target.value)} rows={2} className="mt-1 w-full resize-none bg-transparent text-sm outline-none" placeholder="Enter prompt" /></div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3"><div className="font-mono text-[11px] uppercase tracking-widest text-zinc-500">Response · {active?.models[0]} · 1.9s TTFT</div><div className="mt-1 min-h-[40px] text-sm text-zinc-400">{playLoading ? "Streaming…" : playResp || "Fallback tries models 1→N, failing over on 5xx/stall with context handoff…"}</div></div>
              <Button className="bg-white text-zinc-900 hover:bg-zinc-100" onClick={runPlayground} disabled={playLoading}><Play className="h-4 w-4" /> {playLoading ? "Running…" : `Run via combo ${active?.name}`}</Button>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
