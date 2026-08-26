import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  Server,
  Database,
  Combine,
  BarChart3,
  MessageSquare,
  Activity,
  Settings,
  Menu,
  X,
  Copy,
  Check,
  Eye,
  EyeOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { fetchHealth, getApiKey, setApiKey, API_BASE } from "@/lib/api";

const NAV = [
  { group: "Overview", items: [{ label: "Dashboard", to: "/", icon: LayoutDashboard, badge: null }, { label: "Playground", to: "/playground", icon: MessageSquare, badge: null }] },
  { group: "Providers & Routing", items: [{ label: "Providers", to: "/providers", icon: Server, badge: "8" }, { label: "Models", to: "/models", icon: Database, badge: "419" }, { label: "Proxy Pools", to: "/proxy-pools", icon: Activity, badge: "6 Vercel" }, { label: "Combos", to: "/combos", icon: Combine, badge: "4" }] },
  { group: "Observability", items: [{ label: "Usage", to: "/usage", icon: BarChart3, badge: null }] },
  { group: "System", items: [{ label: "Settings", to: "/settings", icon: Settings, badge: null }] },
] as const;

export function AppLayout({ children }: { children: React.ReactNode }) {
  const loc = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [health, setHealth] = useState<"ok" | "down" | "loading">("loading");
  const [apiKey, setKey] = useState(() => getApiKey());
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const baseUrl = `${API_BASE}/v1`;

  useEffect(() => {
    const c = new AbortController();
    fetchHealth(c.signal)
      .then((h) => setHealth(h.status === "ok" ? "ok" : "down"))
      .catch(() => setHealth("down"));
    return () => c.abort();
  }, [loc.pathname]);

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied(null), 1200);
    });
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-50">
      {/* topbar 56px */}
      <header className="sticky top-0 z-20 flex h-[56px] items-center justify-between border-b border-zinc-800 bg-zinc-950/90 px-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 lg:hidden"
            onClick={() => setMobileOpen((v) => !v)}
            aria-label="toggle menu"
          >
            {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-white text-xs font-black text-zinc-900">◐</span>
            <span className="hidden sm:inline">lmntea-router</span>
            <Badge variant="outline" className="hidden border-zinc-800 bg-zinc-900 text-[11px] font-mono tracking-widest text-zinc-400 sm:inline-flex">v0.1.0 · Hono</Badge>
            <span className={`ml-1 h-2 w-2 rounded-full ${health === "ok" ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" : health === "down" ? "bg-red-500" : "bg-zinc-600"}`} />
            <span className="hidden font-mono text-xs tracking-widest text-zinc-400 sm:inline">{health === "ok" ? "HEALTHY" : health === "down" ? "DOWN" : "…"}</span>
          </Link>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden items-center gap-2 md:flex">
            <span className="font-mono text-xs text-zinc-400">Base URL</span>
            <code className="rounded-lg border border-zinc-800 bg-zinc-900 px-2 py-1 font-mono text-xs text-zinc-300">{baseUrl}</code>
            <Button variant="outline" size="sm" className="border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800" onClick={() => copy(baseUrl, "base")}>
              {copied === "base" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
            </Button>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1">
            <Input
              value={apiKey}
              onChange={(e) => { setKey(e.target.value); setApiKey(e.target.value); }}
              type={reveal ? "text" : "password"}
              placeholder="sk-..."
              className="h-7 w-[160px] border-0 bg-transparent font-mono text-xs focus-visible:ring-0 sm:w-[200px]"
            />
            <Button variant="ghost" size="icon-sm" onClick={() => setReveal((v) => !v)} aria-label="reveal">
              {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => copy(apiKey, "key")} aria-label="copy key">
              {copied === "key" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-56px)] grid-cols-1 lg:grid-cols-[220px_1fr]">
        {/* sidebar 220px desktop, drawer mobile */}
        <aside className={`${mobileOpen ? "block" : "hidden"} border-zinc-800 bg-zinc-950 lg:block lg:border-r`}>
          <div className="sticky top-[56px] flex h-[calc(100vh-56px)] flex-col gap-5 overflow-auto p-3">
            {NAV.map((g) => (
              <div key={g.group} className="flex flex-col gap-1">
                <h4 className="px-2 py-1 font-mono text-[11px] uppercase tracking-widest text-zinc-500">{g.group}</h4>
                {g.items.map((it) => {
                  const active = loc.pathname === it.to || (it.to !== "/" && loc.pathname.startsWith(it.to));
                  const Icon = it.icon;
                  return (
                    <Link
                      key={it.to}
                      to={it.to}
                      onClick={() => setMobileOpen(false)}
                      className={`flex items-center gap-2 rounded-lg border-l-2 px-2.5 py-2 text-sm ${active ? "border-white bg-zinc-900 text-white" : "border-transparent text-zinc-400 hover:bg-zinc-900 hover:text-white"}`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{it.label}</span>
                      {it.badge ? <Badge variant="outline" className="ml-auto border-zinc-800 bg-zinc-900 text-[10px] font-mono text-zinc-400">{it.badge}</Badge> : null}
                    </Link>
                  );
                })}
              </div>
            ))}
            <div className="mt-auto rounded-xl border border-zinc-800 bg-zinc-900 p-3">
              <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.15)]" /> Health <Link to="/" className="underline">/health</Link> · OK
              </div>
              <div className="mt-1 font-mono text-[11px] text-zinc-500">Acerblue · research/ synced</div>
            </div>
          </div>
        </aside>

        {/* main */}
        <main className="min-w-0 bg-zinc-950 p-3 md:p-4 lg:p-[18px]">
          <div className="mx-auto w-full max-w-[1280px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
