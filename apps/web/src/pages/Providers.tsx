import { useEffect, useMemo, useState } from "react";
import { Search, Plus, ShieldAlert, Clock, Eye, EyeOff, Server } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { MOCK_PROVIDERS, type Provider, ApiError, fetchHealth } from "@/lib/api";

type Filter = "All" | "Free" | "OAuth" | "API Key" | "Compatible" | "Has error";

function ProviderCard({ p, onToggle }: { p: Provider; onToggle: (id: string) => void }) {
  const isDisabled = p.status === "disabled";
  return (
    <div className={`flex flex-col gap-2 rounded-xl border bg-card p-4 transition-colors duration-150 ${isDisabled ? "opacity-60" : "hover:border-foreground/25"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background font-mono text-xs font-semibold text-foreground" style={{ background: p.iconBg }}>{p.id.slice(0,2).toUpperCase()}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{p.name}</div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{p.type}</div>
          </div>
        </div>
        <button
          type="button"
          aria-label="toggle"
          onClick={() => onToggle(p.id)}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors duration-150 ${p.status === "disabled" ? "border-border bg-muted" : "border-foreground bg-foreground"}`}
        >
          <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full transition-colors duration-150 ${p.status === "disabled" ? "left-0.5 bg-muted-foreground/60" : "left-[18px] bg-background"}`} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {p.status === "connected" ? <Badge className="gap-1 border-live/30 bg-live/10 text-live"><span className="h-1.5 w-1.5 rounded-full bg-live" /> Connected</Badge> : null}
        {p.status === "error" ? <Badge className="gap-1 border-destructive/30 bg-destructive/10 text-destructive"><span className="h-1.5 w-1.5 rounded-full bg-destructive" /> {p.errorCode === "429" ? "429" : `1 Error (${p.errorCode})`}</Badge> : null}
        {p.status === "disabled" ? <Badge variant="outline" className="gap-1 text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" /> Disabled</Badge> : null}
        {p.errorCode ? <Badge variant="outline" className={`font-mono text-[10px] uppercase ${p.errorCode === "AUTH" ? "border-destructive/30 text-destructive" : p.errorCode === "429" ? "border-warning/30 text-warning" : "text-muted-foreground"}`}>{p.errorCode}</Badge> : null}
      </div>
      <div className="truncate font-mono text-[11px] text-muted-foreground">{p.models?.join(" · ") || p.errorMsg}</div>
      {p.errorMsg && p.status === "error" ? <div className="font-mono text-[11px] text-destructive">{p.errorMsg}</div> : null}
      {isDisabled ? <div className="font-mono text-[11px] text-muted-foreground">No connections · paused</div> : null}
    </div>
  );
}

function AddProviderModal({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [tab, setTab] = useState<"openai" | "anthropic">("openai");
  const [reveal, setReveal] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState<null | { ok: boolean; msg: string }>(null);
  const [healthErr, setHealthErr] = useState<string | null>(null);

  async function doValidate() {
    setValidating(true);
    setValidated(null);
    setHealthErr(null);
    try {
      // probe /health as stand-in for provider validation
      await fetchHealth();
      setValidated({ ok: true, msg: "Validated · /health ok" });
    } catch (e) {
      const msg = e instanceof ApiError ? `${e.status} ${e.message}` : e instanceof Error ? e.message : "validate failed";
      setHealthErr(msg);
      setValidated({ ok: false, msg });
    } finally {
      setValidating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add Compatible Provider</DialogTitle>
          <DialogDescription>Variant: {tab === "openai" ? "OpenAI Compatible" : "Anthropic Messages"} · POST /api/providers</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="openai">OpenAI Compatible</TabsTrigger>
            <TabsTrigger value="anthropic">Anthropic Compatible</TabsTrigger>
          </TabsList>
          <TabsContent value="openai" className="mt-4 grid gap-3">
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Provider Name</Label><Input defaultValue="my-openai-relay" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Base URL</Label><Input defaultValue="https://api.example.com/v1" className="font-mono" /></div>
            <div className="grid gap-1.5">
              <Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">API Key</Label>
              <div className="flex gap-2"><Input type={reveal ? "text" : "password"} defaultValue="sk-proj-...xxxx" className="flex-1 font-mono" /><Button type="button" variant="outline" size="sm" onClick={() => setReveal((v)=>!v)}>{reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {reveal ? "Hide" : "Reveal"}</Button></div>
            </div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">API Type</Label>
              <Select defaultValue="responses"><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chat">Chat Completions</SelectItem><SelectItem value="responses">Responses API</SelectItem></SelectContent></Select>
              <span className="font-mono text-[11px] text-muted-foreground">responses → /providers/oai-r.png · chat → /providers/oai-cc.png</span>
            </div>
          </TabsContent>
          <TabsContent value="anthropic" className="mt-4 grid gap-3">
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Provider Name</Label><Input defaultValue="my-claude-relay" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">Base URL</Label><Input defaultValue="https://api.anthropic.com" className="font-mono" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-muted-foreground">API Key</Label><Input type={reveal ? "text" : "password"} defaultValue="sk-ant-xxxx" className="font-mono" /></div>
          </TabsContent>
        </Tabs>
        <div className="flex gap-2">
          <Input placeholder="check model id (optional)" defaultValue="gpt-4o-mini" className="flex-1 font-mono" />
          <Button variant="outline" onClick={doValidate} disabled={validating}>{validating ? "Validating…" : "Validate"}</Button>
        </div>
        {validated ? (
          <div className={`flex items-center gap-2 rounded-md border p-3 font-mono text-xs ${validated.ok ? "border-live/30 bg-live/10 text-live" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
            <span className={`h-2 w-2 rounded-full ${validated.ok ? "bg-live" : "bg-destructive"}`} /> {validated.msg}
          </div>
        ) : null}
        {healthErr ? <div className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 font-mono text-xs text-warning">{healthErr} — {healthErr.includes("401") ? "check API key" : healthErr.includes("429") ? "rate limited, retry later" : healthErr.includes("413") ? "payload too large" : "server error, will failover"}</div> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button>Create Provider</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function Providers() {
  const [loading, setLoading] = useState(true);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [filter, setFilter] = useState<Filter>("All");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("connected");
  const [modalOpen, setModalOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    // mock fetch with abort + 400ms skeleton
    const t = setTimeout(() => {
      if (ac.signal.aborted) return;
      setProviders(MOCK_PROVIDERS);
      setLoading(false);
    }, 450);
    fetchHealth(ac.signal).catch((e) => {
      if (e instanceof ApiError && e.status === 401) setErr("401 Unauthorized — check Bearer token");
      else if (e instanceof ApiError && e.status === 429) setErr("429 Rate limited — backoff");
      else if (e instanceof ApiError && e.status === 413) setErr("413 Payload too large");
      else if (e instanceof ApiError && e.status >= 500) setErr(`5xx ${e.message} — failover`);
    });
    return () => { clearTimeout(t); ac.abort(); };
  }, []);

  function toggle(id: string) {
    setProviders((prev) => prev.map((p) => p.id === id ? { ...p, status: p.status === "disabled" ? "connected" : "disabled" } as Provider : p));
  }

  const filtered = useMemo(() => {
    let out = [...providers];
    if (q) {
      const qq = q.toLowerCase();
      out = out.filter((p) => p.name.toLowerCase().includes(qq) || p.errorCode?.toLowerCase().includes(qq) || p.type.toLowerCase().includes(qq));
    }
    if (filter !== "All") {
      if (filter === "Has error") out = out.filter((p) => p.status === "error");
      else if (filter === "Free") out = out.filter((p) => p.id === "opencode");
      else if (filter === "OAuth") out = out.filter((p) => p.type.includes("OAuth"));
      else if (filter === "API Key") out = out.filter((p) => p.type.includes("API Key"));
      else if (filter === "Compatible") out = out.filter((p) => p.type.includes("Compatible"));
    }
    if (sort === "connected") {
      const order = { connected: 0, error: 1, idle: 2, disabled: 3 } as const;
      out.sort((a,b) => (order[a.status] ?? 2) - (order[b.status] ?? 2));
    } else if (sort === "name") out.sort((a,b)=>a.name.localeCompare(b.name));
    else if (sort === "errors") out.sort((a,b)=> (a.status==="error"?0:1)-(b.status==="error"?0:1));
    return out;
  }, [providers, q, filter, sort]);

  const connected = providers.filter((p)=>p.status==="connected").length;
  const errors = providers.filter((p)=>p.status==="error").length;
  const disabled = providers.filter((p)=>p.status==="disabled").length;

  return (
    <div className="space-y-3">
      <PageHeader
        title="Providers"
        description="Provider specs and status — static catalog (MOCK_PROVIDERS) · /health checks live · sorted Connected first → Error (AUTH/429/5XX/NET) → Idle"
      >
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search providers / error code" className="w-[260px] pl-8" />
        </div>
        <Button variant="outline" onClick={()=>setModalOpen(true)}><Plus className="h-4 w-4" /> Add Compatible Provider</Button>
        <Button onClick={()=>setModalOpen(true)}><Plus className="h-4 w-4" /> Add Provider</Button>
      </PageHeader>

      {loading ? (
        <>
          <Skeleton className="h-10 w-full" />
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>{Array.from({length:8}).map((_,i)=><Skeleton key={i} className="h-[140px]" />)}</div>
        </>
      ) : (
        <>
          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3">
              <Badge className="gap-1 border-live/30 bg-live/10 text-live"><span className="h-1.5 w-1.5 rounded-full bg-live" /> Connected <span className="font-mono tabular-nums">{connected}</span></Badge>
              <Badge className="gap-1 border-destructive/30 bg-destructive/10 text-destructive"><span className="h-1.5 w-1.5 rounded-full bg-destructive" /> <span className="font-mono tabular-nums">{errors}</span> Errors</Badge>
              {disabled > 0 ? <Badge variant="outline" className="gap-1 text-muted-foreground">Disabled <span className="font-mono tabular-nums">{disabled}</span></Badge> : null}
              <span className="flex-1" />
              <Select value={sort} onValueChange={(v)=> { if (v) setSort(v); }}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="connected">Sort: Connected first</SelectItem><SelectItem value="name">Name A-Z</SelectItem><SelectItem value="errors">Errors first</SelectItem></SelectContent>
              </Select>
            </CardContent>
          </Card>

          <div className="flex flex-wrap gap-2">
            {(["All","Free","OAuth","API Key","Compatible","Has error"] as const).map((f) => (
              <button key={f} onClick={()=>setFilter(f)} className={`rounded-md border px-3 py-1.5 font-mono text-xs transition-colors duration-150 ${filter===f ? "border-foreground bg-foreground text-background" : "border bg-card text-muted-foreground hover:text-foreground"}`}>{f}</button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <Empty className="border border-dashed bg-card">
              <EmptyHeader>
                <EmptyMedia variant="icon"><Server className="h-4 w-4" /></EmptyMedia>
                <EmptyTitle>No providers</EmptyTitle>
                <EmptyDescription>No providers match “{q}” {filter !== "All" ? `· filter ${filter}` : ""}</EmptyDescription>
              </EmptyHeader>
              <Button variant="outline" onClick={()=>{setQ(""); setFilter("All");}}><Clock className="h-4 w-4" /> Clear filters</Button>
            </Empty>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>
              {filtered.map((p) => <ProviderCard key={p.id} p={p} onToggle={toggle} />)}
            </div>
          )}

          {err ? <div className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 font-mono text-xs text-warning"><ShieldAlert className="h-4 w-4" /> {err}</div> : null}

          <Card>
            <CardContent className="flex flex-wrap items-center gap-2 p-3 font-mono text-xs text-muted-foreground">
              <span>Legend:</span>
              <Badge className="border-live/30 bg-live/10 text-live">Connected</Badge>
              <Badge className="border-destructive/30 bg-destructive/10 text-destructive">Error (AUTH/429/5XX/NET)</Badge>
              <Badge variant="outline" className="border-destructive/30 text-destructive">AUTH</Badge>
              <Badge variant="outline" className="border-warning/30 text-warning">429</Badge>
              <Badge variant="outline" className="text-muted-foreground">5XX</Badge>
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
            <span className="text-[13px] text-muted-foreground"><strong className="font-medium text-foreground">Inherit model, no override</strong> — connections inherit model capabilities from registry; provider cards show status only.</span>
          </div>
        </>
      )}

      <AddProviderModal open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
