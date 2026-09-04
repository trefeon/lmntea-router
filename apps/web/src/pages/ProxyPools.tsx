import { useEffect, useMemo, useState } from "react";
import { Search, Plus, Trash2, Edit2, Check, Shield, Cloud, Zap, Eye, EyeOff, RotateCw, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { MOCK_RELAYS, type Relay, ApiError } from "@/lib/api";

const colLabel = "font-mono text-xs uppercase tracking-widest text-muted-foreground";
const cardLabel = "font-mono text-xs uppercase tracking-widest text-muted-foreground";

// Status dot: semantic only (live / warning / destructive) — never decorative.
const statusDot = (status: number) =>
  status >= 500 ? "bg-destructive" : status >= 400 ? "bg-warning" : "bg-live";

export default function ProxyPools() {
  const [loading, setLoading] = useState(true);
  const [pools, setPools] = useState<Relay[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(["trefeon","hermes","feoni","verokes","axetant","raxtant"]));
  const [q, setQ] = useState("");
  const [editOpen, setEditOpen] = useState<Relay | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [strict, setStrict] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [healthError, setHealthError] = useState<string | null>(null);
  const [batchText, setBatchText] = useState("https://trefeon-xxxxx.vercel.app/api/relay\nhttp://user:pass@1.2.3.4:8080\n1.2.3.4:8080:user:pass");

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(() => {
      if (ac.signal.aborted) return;
      setPools(MOCK_RELAYS);
      setLoading(false);
    }, 400);
    return () => { clearTimeout(t); ac.abort(); };
  }, []);

  async function testPool(id: string) {
    setTesting(id);
    setHealthError(null);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 25000);
    try {
      // simulate 25s watchdog: ping /health with 8s, fall back to mock
      await new Promise((r) => setTimeout(r, 700));
      if (Math.random() < 0.08) throw new ApiError("504 Gateway Timeout", 504);
      setPools((prev) => prev.map((p) => p.id === id ? { ...p, latencyMs: 10 + Math.floor(Math.random()*20), lastCheck: "now" } : p));
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "failed";
      setHealthError(`${id}: ${msg} — ${msg.includes("504") ? "watchdog failover to sibling" : msg.includes("401") ? "AUTH rotate" : msg.includes("429") ? "backoff" : msg.includes("413") ? "payload too large" : "5xx failover"}`);
    } finally {
      clearTimeout(timer);
      setTesting(null);
    }
  }

  const filtered = useMemo(() => {
    if (!q) return pools;
    const qq = q.toLowerCase();
    return pools.filter((p) => p.name.toLowerCase().includes(qq) || p.url.toLowerCase().includes(qq));
  }, [pools, q]);

  const batchParsed = useMemo(() => {
    const lines = batchText.split("\n").map((s)=>s.trim()).filter(Boolean);
    return { parsed: lines.length, skipped: 0, failed: 0 };
  }, [batchText]);

  if (loading) {
    return <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-[320px] w-full" /></div>;
  }

  return (
    <div className="space-y-3">
      <PageHeader title="Proxy Pools" description="Relay pool inventory — mock relays (MOCK_RELAYS) · 6 Vercel relays · Random rotation · simulated health pings">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search pools" className="w-[200px] pl-8" />
        </div>
        <Button variant="outline" onClick={()=>setDeployOpen(true)}><Cloud className="h-4 w-4" /> Deploy Relay ▾</Button>
        <Button variant="outline" onClick={()=>setBatchOpen(true)}>Batch Import</Button>
        <Button onClick={()=>setBatchOpen(true)}><Plus className="h-4 w-4" /> Add Proxy Pool</Button>
      </PageHeader>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <label className="flex items-center gap-2 font-mono text-xs text-muted-foreground"><input type="checkbox" checked={selected.size===pools.length} onChange={(e)=> setSelected(e.target.checked ? new Set(pools.map((p)=>p.id)) : new Set())} /> Select all</label>
          <Badge variant="outline" className="font-mono text-xs tabular-nums">Total: {pools.length}</Badge>
          <Badge className="gap-1 border-live/30 bg-live/10 text-live tabular-nums"><span className="h-1.5 w-1.5 rounded-full bg-live" /> Active: {pools.length}</Badge>
          <Badge variant="outline" className="font-mono text-xs">Type: Vercel Edge</Badge>
          <Badge variant="outline" className="font-mono text-xs">ALL_VERCEL_RELAYS · proxyFetch.js</Badge>
          <span className="flex-1" />
          <Button size="sm" variant="outline" onClick={()=> pools.forEach((p)=> testPool(p.id))}><RefreshCw className="h-3.5 w-3.5" /> Health Check — 10 concurrent</Button>
          <Button size="sm" variant="destructive">Disable Dead</Button>
        </CardContent>
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-9"><input type="checkbox" checked={selected.size===pools.length} onChange={(e)=> setSelected(e.target.checked ? new Set(pools.map((p)=>p.id)) : new Set())} /></TableHead>
                <TableHead className={colLabel}>Name</TableHead>
                <TableHead className={colLabel}>Proxy URL</TableHead>
                <TableHead className={colLabel}>Type</TableHead>
                <TableHead className={colLabel}>Health</TableHead>
                <TableHead className={colLabel}>Strict Proxy</TableHead>
                <TableHead className={colLabel}>Last Check</TableHead>
                <TableHead className="text-right font-mono text-xs uppercase tracking-widest text-muted-foreground">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow><TableCell colSpan={8} className="p-0"><Empty><EmptyHeader><EmptyMedia variant="icon"><Search className="h-4 w-4" /></EmptyMedia><EmptyTitle>No pools</EmptyTitle><EmptyDescription>No proxy pools match “{q}”</EmptyDescription></EmptyHeader></Empty></TableCell></TableRow>
              ) : filtered.map((p) => (
                <TableRow key={p.id}>
                  <TableCell><input type="checkbox" checked={selected.has(p.id)} onChange={(e)=> setSelected((prev)=> { const n=new Set(prev); if(e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2"><span className="h-2 w-2 rounded-full bg-live" /><span className="font-mono text-sm font-semibold">{p.name}</span></div>
                    <div className="font-mono text-[11px] text-muted-foreground">{p.id} · primary</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{p.url}</TableCell>
                  <TableCell><Badge variant="outline" className="font-mono text-xs">{p.type}</Badge></TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 font-mono text-xs tabular-nums"><span className={`h-1.5 w-1.5 rounded-full ${statusDot(p.status)}`} /> {p.latencyMs}ms <Badge variant="outline" className="font-mono text-[11px] tabular-nums">{p.status} OK</Badge></span>
                  </TableCell>
                  <TableCell><Switch checked={p.strict} onCheckedChange={(v)=> setPools((prev)=> prev.map((x)=> x.id===p.id ? { ...x, strict: v } : x))} /></TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground tabular-nums">{p.lastCheck}</TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex gap-1">
                      <Button size="xs" variant="outline" onClick={()=> testPool(p.id)} disabled={testing===p.id}>{testing===p.id ? "Testing…" : "Test"}</Button>
                      <Button size="xs" variant="outline" onClick={()=> setEditOpen(p)}><Edit2 className="h-3 w-3" /> Edit</Button>
                      <Button size="xs" variant="destructive"><Trash2 className="h-3 w-3" /> Delete</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t bg-background p-3">
          <span className="font-mono text-xs text-muted-foreground">Bulk: with selection →</span>
          <Button size="xs" variant="outline">Activate</Button>
          <Button size="xs" variant="outline">Deactivate</Button>
          <Button size="xs" variant="destructive">Delete Selected</Button>
          <span className="flex-1" />
          <span className="font-mono text-xs text-muted-foreground">409 bound → “Cannot delete: N connection(s) still using this pool”</span>
        </div>
      </Card>

      {healthError ? <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 font-mono text-xs text-warning">{healthError}</div> : null}

      <div className="grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2"><CardTitle className={cardLabel}>Rotation Strategy</CardTitle><Badge className="border-live/30 bg-live/10 text-live">Random · 6 pools</Badge></CardHeader>
          <CardContent>
            <div className="grid grid-cols-[120px_1fr] gap-4">
              <div className="relative flex h-[120px] w-[120px] items-center justify-center rounded-full border border-dashed bg-background">
                <span className="text-center font-mono text-xs text-muted-foreground">RANDOM<br /><span className="font-bold text-foreground">Rotation</span></span>
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">TF</span>
                <span className="absolute right-0 top-1/3 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">HE</span>
                <span className="absolute bottom-1/3 right-0 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">FE</span>
                <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">VE</span>
                <span className="absolute bottom-1/3 left-0 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">AX</span>
                <span className="absolute left-0 top-1/3 rounded-full border bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground">RA</span>
              </div>
              <div className="grid gap-2">
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"><span className="font-mono text-xs">Strategy</span><Badge>Random</Badge></div>
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"><span className="font-mono text-xs">Watchdog</span><span className="font-mono text-xs text-muted-foreground">25s → sibling failover</span></div>
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"><span className="font-mono text-xs">Transport</span><span className="font-mono text-[11px] text-muted-foreground">RELAY_POOL_AGENT h2:4 keepAlive 30s</span></div>
                <div className="flex items-center justify-between rounded-lg border bg-background px-3 py-2"><span className="font-mono text-xs">Strict Proxy</span><span className="flex items-center gap-2"><Badge>ON</Badge><Switch checked={strict} onCheckedChange={setStrict} /></span></div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-background px-3 py-2">
              <span className="font-mono text-xs text-muted-foreground">25s watchdog → sibling failover (100% proxied, zero direct leakage)</span><Badge>Strict Proxy ON</Badge>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <Card>
            <CardHeader className="pb-2"><CardTitle className={cardLabel}>Vercel Deploy — Edge Relay</CardTitle><p className="font-mono text-[11px] text-muted-foreground">Deploys hardened handler with x-relay-auth + isPrivateHostname SSRF guard</p></CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1.5"><Label className={cardLabel}>Vercel Token</Label>
                <div className="flex gap-2"><Input type={reveal["vtoken"] ? "text" : "password"} defaultValue="vercel_pat_xxxxxxxx" className="flex-1 font-mono" /><Button size="sm" variant="outline" onClick={()=> setReveal((s)=> ({...s, vtoken: !s["vtoken"]}))}>{reveal["vtoken"] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {reveal["vtoken"] ? "Hide" : "Reveal"}</Button></div></div>
              <div className="grid gap-1.5"><Label className={cardLabel}>Project Name</Label><Input defaultValue="vercel-relay" className="font-mono" /></div>
              <div className="grid gap-1.5"><Label className={cardLabel}>x-relay-auth (masked)</Label>
                <div className="flex gap-2"><Input type={reveal["rauth"] ? "text" : "password"} defaultValue="a8f3c9d2e1b4..." className="flex-1 font-mono" /><Button size="sm" variant="outline" onClick={()=> setReveal((s)=> ({...s, rauth: !s["rauth"]}))}>{reveal["rauth"] ? <EyeOff className="h-4 w-4"/> : <Eye className="h-4 w-4" />} {reveal["rauth"] ? "Hide" : "Reveal"}</Button><Button size="sm" variant="outline"><RotateCw className="h-4 w-4" /> Rotate</Button></div>
                <span className="font-mono text-[11px] text-muted-foreground">crypto.randomBytes(32).toString("hex") · validated in Edge handler · 401 if mismatch</span>
              </div>
              <Button onClick={()=>setDeployOpen(true)}><Zap className="h-4 w-4" /> Deploy Vercel Relay</Button>
              {deployOpen ? <div className="rounded-lg border border-dashed bg-background p-3 font-mono text-xs text-live">✔ Deployed: https://vercel-relay-xxxx.vercel.app/api/relay</div> : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className={cardLabel}>Security — Hardened Relay Template</CardTitle></CardHeader>
            <CardContent className="grid gap-2">
              <div className="flex items-center gap-2 font-mono text-xs"><span className="h-1.5 w-1.5 rounded-full bg-live" /> x-relay-auth validation <Badge variant="outline" className="ml-auto font-mono text-[11px]">401 Unauthorized</Badge></div>
              <div className="flex items-center gap-2 font-mono text-xs"><span className="h-1.5 w-1.5 rounded-full bg-live" /> isPrivateHostname() SSRF block <Badge variant="outline" className="ml-auto font-mono text-[11px]">403 Forbidden</Badge></div>
              <div className="rounded-lg border bg-background p-2 font-mono text-[11px] text-muted-foreground">blocks 10.0.0.0/8 · 172.16.0.0/12 · 192.168.0.0/16 · 127.0.0.1 · ::1 · 169.254.169.254</div>
              <div className="flex items-center gap-2 font-mono text-xs"><span className="h-1.5 w-1.5 rounded-full bg-live" /> Protocol guard https:/http: only <Badge variant="outline" className="ml-auto font-mono text-[11px]">403</Badge></div>
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2"><CardTitle className={cardLabel}>Edit Proxy Pool — modal wire</CardTitle><p className="font-mono text-xs text-muted-foreground">PUT /api/proxy-pools/:id · fields: name, proxyUrl, noProxy, isActive, strictProxy</p></CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid gap-1.5"><Label className={cardLabel}>Name</Label><Input defaultValue={editOpen?.name ?? "trefeon"} /></div>
            <div className="grid gap-1.5"><Label className={cardLabel}>Proxy URL</Label><Input defaultValue={editOpen?.url ?? "https://trefeon-7r9gingdf...vercel.app/api/relay"} className="font-mono" /></div>
            <div className="grid gap-1.5"><Label className={cardLabel}>No Proxy (bypass)</Label><Input placeholder="localhost,127.0.0.1" className="font-mono" /></div>
            <div className="flex gap-4"><label className="flex items-center gap-2 text-sm"><Switch defaultChecked /> Active</label><label className="flex items-center gap-2 text-sm"><Switch defaultChecked /> Strict Proxy</label></div>
            <div className="flex justify-end gap-2"><Button variant="outline" onClick={()=>setEditOpen(null)}>Cancel</Button><Button onClick={()=>setEditOpen(null)}>Save</Button></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className={cardLabel}>Batch Import — wire</CardTitle><p className="font-mono text-xs text-muted-foreground">Accepts http(s):// or host:port:user:pass per line · dedupes proxyUrl+noProxy</p></CardHeader>
          <CardContent>
            <Textarea value={batchText} onChange={(e)=>setBatchText(e.target.value)} rows={5} className="font-mono" />
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-xs text-muted-foreground">Parsed {batchParsed.parsed} · Skipped 1 dup · Failed 0</span>
              <Button onClick={()=>setBatchOpen(false)}>Import</Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!editOpen} onOpenChange={(v)=> !v && setEditOpen(null)}>
        <DialogContent><DialogHeader><DialogTitle>Edit Proxy Pool</DialogTitle><DialogDescription>Update pool {editOpen?.name}</DialogDescription></DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5"><Label>Name</Label><Input defaultValue={editOpen?.name} /></div>
            <div className="grid gap-1.5"><Label>Proxy URL</Label><Input defaultValue={editOpen?.url} className="font-mono" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={()=>setEditOpen(null)}>Cancel</Button><Button onClick={()=>setEditOpen(null)}>Save</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={batchOpen} onOpenChange={setBatchOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Batch Import</DialogTitle><DialogDescription>Paste proxy URLs — one per line</DialogDescription></DialogHeader>
          <Textarea value={batchText} onChange={(e)=>setBatchText(e.target.value)} rows={6} className="font-mono" />
          <DialogFooter><Button onClick={()=>setBatchOpen(false)}>Import {batchParsed.parsed}</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deployOpen} onOpenChange={setDeployOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Shield className="h-4 w-4" /> Vercel Deploy</DialogTitle><DialogDescription>Deploys hardened handler with x-relay-auth guard</DialogDescription></DialogHeader>
          <div className="rounded-lg border bg-background p-3 font-mono text-xs text-muted-foreground">POST /api/proxy-pools/vercel-deploy · 401 if x-relay-auth mismatch · 403 if private hostname</div>
          <DialogFooter><Button onClick={()=>setDeployOpen(false)}><Check className="h-4 w-4" /> Done</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
