import { useEffect, useMemo, useState } from "react";
import { Search, Plus, ShieldAlert, Clock, Eye, EyeOff, Server } from "lucide-react";
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
  const isError = p.status === "error";
  const isDisabled = p.status === "disabled";
  return (
    <div className={`flex flex-col gap-2 rounded-2xl border bg-zinc-900 p-4 transition hover:border-zinc-700 ${isError ? "border-red-500/30" : isDisabled ? "opacity-60 border-zinc-800" : "border-zinc-800"}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-950 text-xs font-black text-white" style={{ background: p.iconBg }}>{p.id.slice(0,2).toUpperCase()}</span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{p.name}</div>
            <div className="truncate font-mono text-[11px] text-zinc-500">{p.type}</div>
          </div>
        </div>
        <button
          type="button"
          aria-label="toggle"
          onClick={() => onToggle(p.id)}
          className={`relative h-5 w-9 shrink-0 rounded-full border transition ${p.status === "disabled" ? "border-zinc-700 bg-zinc-800" : "border-white bg-white"}`}
        >
          <span className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-zinc-900 transition ${p.status === "disabled" ? "left-0.5" : "left-[18px]"}`} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {p.status === "connected" ? <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected</Badge> : null}
        {p.status === "error" ? <Badge className="gap-1 border-red-500/30 bg-red-500/10 text-red-300"><span className="h-1.5 w-1.5 rounded-full bg-red-500" /> {p.errorCode === "429" ? "429" : `1 Error (${p.errorCode})`}</Badge> : null}
        {p.status === "disabled" ? <Badge variant="outline" className="border-zinc-800 bg-zinc-950 text-zinc-400">○ Disabled</Badge> : null}
        {p.errorCode ? <Badge variant="outline" className={`font-mono text-[10px] uppercase ${p.errorCode === "AUTH" ? "border-red-500/30 text-red-300" : p.errorCode === "429" ? "border-amber-500/30 text-amber-300" : "border-zinc-800 text-zinc-400"}`}>{p.errorCode}</Badge> : null}
        {p.status === "connected" && p.id === "opencode" ? <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs text-zinc-400">TTFT 1.8s</Badge> : null}
      </div>
      <div className="truncate font-mono text-[11px] text-zinc-500">{p.models?.join(" · ") || p.errorMsg}</div>
      {p.errorMsg && p.status === "error" ? <div className="font-mono text-[11px] text-red-300">{p.errorMsg}</div> : null}
      {isDisabled ? <div className="font-mono text-[11px] text-zinc-500">No connections · paused</div> : null}
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
      setValidated({ ok: true, msg: "Validated · 9 models · context 128k · tools ok" });
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
      <DialogContent className="border-zinc-800 bg-zinc-900 text-white sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Add Compatible Provider</DialogTitle>
          <DialogDescription className="text-zinc-400">Variant: {tab === "openai" ? "OpenAI Compatible" : "Anthropic Messages"} · POST /api/providers</DialogDescription>
        </DialogHeader>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="bg-zinc-950">
            <TabsTrigger value="openai">OpenAI Compatible</TabsTrigger>
            <TabsTrigger value="anthropic">Anthropic Compatible</TabsTrigger>
          </TabsList>
          <TabsContent value="openai" className="mt-4 grid gap-3">
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">Provider Name</Label><Input defaultValue="my-openai-relay" className="border-zinc-800 bg-zinc-950" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">Base URL</Label><Input defaultValue="https://api.example.com/v1" className="border-zinc-800 bg-zinc-950 font-mono" /></div>
            <div className="grid gap-1.5">
              <Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">API Key</Label>
              <div className="flex gap-2"><Input type={reveal ? "text" : "password"} defaultValue="sk-proj-...xxxx" className="flex-1 border-zinc-800 bg-zinc-950 font-mono" /><Button type="button" variant="outline" size="sm" className="border-zinc-800 bg-zinc-950" onClick={() => setReveal((v)=>!v)}>{reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} {reveal ? "Hide" : "Reveal"}</Button></div>
            </div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">API Type</Label>
              <Select defaultValue="responses"><SelectTrigger className="border-zinc-800 bg-zinc-950"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="chat">Chat Completions</SelectItem><SelectItem value="responses">Responses API</SelectItem></SelectContent></Select>
              <span className="font-mono text-[11px] text-zinc-500">responses → /providers/oai-r.png · chat → /providers/oai-cc.png</span>
            </div>
          </TabsContent>
          <TabsContent value="anthropic" className="mt-4 grid gap-3">
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">Provider Name</Label><Input defaultValue="my-claude-relay" className="border-zinc-800 bg-zinc-950" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">Base URL</Label><Input defaultValue="https://api.anthropic.com" className="border-zinc-800 bg-zinc-950 font-mono" /></div>
            <div className="grid gap-1.5"><Label className="font-mono text-xs uppercase tracking-widest text-zinc-500">API Key</Label><Input type={reveal ? "text" : "password"} defaultValue="sk-ant-xxxx" className="border-zinc-800 bg-zinc-950 font-mono" /></div>
          </TabsContent>
        </Tabs>
        <div className="flex gap-2">
          <Input placeholder="check model id (optional)" defaultValue="gpt-4o-mini" className="flex-1 border-zinc-800 bg-zinc-950 font-mono" />
          <Button variant="outline" className="border-zinc-800 bg-zinc-950" onClick={doValidate} disabled={validating}>{validating ? "Validating…" : "Validate"}</Button>
        </div>
        {validated ? (
          <div className={`flex items-center gap-2 rounded-xl border p-3 font-mono text-xs ${validated.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/30 bg-red-500/10 text-red-300"}`}>
            <span className={`h-2 w-2 rounded-full ${validated.ok ? "bg-emerald-500" : "bg-red-500"}`} /> {validated.msg} {validated.ok ? <Badge variant="outline" className="ml-auto border-emerald-500/30 bg-emerald-500/10 text-emerald-300">200</Badge> : null}
          </div>
        ) : null}
        {healthErr ? <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 font-mono text-xs text-amber-200">{healthErr} — {healthErr.includes("401") ? "check API key" : healthErr.includes("429") ? "rate limited, retry later" : healthErr.includes("413") ? "payload too large" : "server error, will failover"}</div> : null}
        <DialogFooter>
          <Button variant="outline" className="border-zinc-800 bg-zinc-950" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-white text-zinc-900 hover:bg-zinc-100">Create Provider</Button>
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

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full bg-zinc-900" />
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>{Array.from({length:8}).map((_,i)=><Skeleton key={i} className="h-[140px] bg-zinc-900" />)}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Providers</h1>
          <p className="font-mono text-xs text-zinc-500">8 providers · Sorted: Connected first → Error (AUTH/429/5XX/NET) → Idle · Inherit model, no override</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
            <Input value={q} onChange={(e)=>setQ(e.target.value)} placeholder="Search providers / error code" className="w-[260px] border-zinc-800 bg-zinc-900 pl-8" />
          </div>
          <Button variant="outline" className="border-zinc-800 bg-zinc-900" onClick={()=>setModalOpen(true)}><Plus className="h-4 w-4" /> Add Compatible Provider</Button>
          <Button className="bg-white text-zinc-900 hover:bg-zinc-100" onClick={()=>setModalOpen(true)}><Plus className="h-4 w-4" /> Add Provider</Button>
        </div>
      </div>

      <Card className="border-zinc-800 bg-zinc-900">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">Total 8</Badge>
          <Badge className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-emerald-300"><span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected {connected}</Badge>
          <Badge className="gap-1 border-red-500/30 bg-red-500/10 text-red-300"><span className="h-1.5 w-1.5 rounded-full bg-red-500" /> {errors} Errors</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950 text-zinc-400">Idle 2 · Disabled 1</Badge>
          <span className="flex-1" />
          <span className="font-mono text-[11px] text-zinc-500">getStatusDisplay() · getConnectionErrorTag()</span>
          <Select value={sort} onValueChange={(v)=> { if (v) setSort(v); }}>
            <SelectTrigger className="w-[180px] border-zinc-800 bg-zinc-950"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="connected">Sort: Connected first</SelectItem><SelectItem value="name">Name A-Z</SelectItem><SelectItem value="errors">Errors first</SelectItem></SelectContent>
          </Select>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {(["All","Free","OAuth","API Key","Compatible","Has error"] as const).map((f) => (
          <button key={f} onClick={()=>setFilter(f)} className={`rounded-full border px-3 py-1 font-mono text-xs ${filter===f ? "border-white bg-white text-zinc-900" : "border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-white"}`}>{f}{f==="Free" ? " · 2" : f==="OAuth" ? " · 2" : f==="API Key" ? " · 2" : f==="Compatible" ? " · 2" : ""}</button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Empty className="border border-dashed border-zinc-800 bg-zinc-900">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Server className="h-4 w-4" /></EmptyMedia>
            <EmptyTitle>No providers</EmptyTitle>
            <EmptyDescription>No providers match “{q}” {filter !== "All" ? `· filter ${filter}` : ""}</EmptyDescription>
          </EmptyHeader>
          <Button variant="outline" className="border-zinc-800 bg-zinc-950" onClick={()=>{setQ(""); setFilter("All");}}><Clock className="h-4 w-4" /> Clear filters</Button>
        </Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))" }}>
          {filtered.map((p) => <ProviderCard key={p.id} p={p} onToggle={toggle} />)}
        </div>
      )}

      {err ? <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 font-mono text-xs text-amber-200"><ShieldAlert className="h-4 w-4" /> {err}</div> : null}

      <Card className="border-zinc-800 bg-zinc-900">
        <CardContent className="flex flex-wrap items-center gap-2 p-3 font-mono text-xs text-zinc-500">
          <span>Legend:</span>
          <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">Connected</Badge>
          <Badge className="border-red-500/30 bg-red-500/10 text-red-300">Error (AUTH/429/5XX/NET)</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950">AUTH</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950">429</Badge>
          <Badge variant="outline" className="border-zinc-800 bg-zinc-950">5XX</Badge>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-3">
        <span className="text-sm"><strong>Inherit model, no override</strong> — connections inherit model capabilities from registry; provider cards show status only.</span>
        <Badge variant="outline" className="border-zinc-800 bg-zinc-950 font-mono text-xs">ProviderIcon 32px · rounded-10</Badge>
      </div>

      <AddProviderModal open={modalOpen} onOpenChange={setModalOpen} />
    </div>
  );
}
