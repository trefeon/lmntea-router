import { Activity, AlertTriangle, ArrowRight, Check, Copy, GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { FirstRunReadinessCard } from "@/components/FirstRunReadinessCard";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchHealth, fetchModels, getApiBase } from "@/lib/api";

const PIPELINE = [
  { stage: "1 · Ingress & Auth", note: "Bearer / x-api-key · body limit" },
  { stage: "2 · Normalize", note: "clamp · sanitize · thinking" },
  { stage: "3 · Translate", note: "OpenAI ↔ Claude ↔ Gemini" },
  { stage: "4 · Route & Combo", note: "circuit breaker · failover" },
  { stage: "5 · Transport", note: "relay pool · SSRF guard" },
  { stage: "6 · Stream", note: "keepalive · stall watchdog" },
] as const;

function StatCard({
  label,
  loading,
  children,
}: {
  label: string;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <Card className="bg-card">
      <CardContent className="p-4">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
          {label}
        </div>
        <div className="mt-2">
          {loading ? <Skeleton className="h-7 w-20 bg-muted" /> : children}
        </div>
      </CardContent>
    </Card>
  )
}

export default function Dashboard() {
  const [health, setHealth] = useState<{ status: string; latencyMs?: number; version?: string } | null>(null);
  const [models, setModels] = useState<{ count: number; providers: number; fromMock: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const base = getApiBase() || (typeof window !== "undefined" ? window.location.origin : "");

  let loadSeq = 0;
  const load = () => {
    const seq = ++loadSeq;
    const ac = new AbortController();
    setLoading(true);
    setErr(null);
    Promise.allSettled([fetchHealth(ac.signal), fetchModels(ac.signal)])
      .then(([h, m]) => {
        if (seq !== loadSeq) return;
        if (h.status === "fulfilled") setHealth(h.value);
        if (m.status === "fulfilled") {
          const entries = m.value.data;
          const providers = new Set(
            entries
              .map((e) => e.provider || (e.id.includes("/") ? e.id.split("/")[0] : undefined))
              .filter((p): p is string => Boolean(p)),
          ).size;
          setModels({ count: entries.length, providers, fromMock: m.value.fromMock });
        }
        const failed = [h, m].filter((x) => x.status === "rejected") as PromiseRejectedResult[];
        if (failed.length > 0) {
          setErr(failed.map((f) => (f.reason instanceof Error ? f.reason.message : String(f.reason))).join(" · "));
        }
      })
      .finally(() => {
        if (seq === loadSeq) setLoading(false);
      });
    return () => ac.abort();
  };

  useEffect(load, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${base}/v1`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* noop */
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description="Router health and live registry state." />

      <FirstRunReadinessCard />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="API" loading={loading}>
          <div className="flex items-center gap-2">
            <span className={`inline-block size-2 rounded-full ${health?.status === "ok" ? "bg-live" : health ? "bg-destructive" : "bg-muted-foreground/50"}`} aria-hidden />
            <span className="font-mono text-2xl tracking-tight">
              {health?.status === "ok" ? "ok" : health ? "down" : "—"}
            </span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground/60">
            {health?.latencyMs != null ? `${health.latencyMs}ms round-trip` : "/health"}
          </div>
        </StatCard>

        <StatCard label="Models" loading={loading}>
          <div className="font-mono text-2xl tracking-tight tabular-nums">
            {models ? models.count.toLocaleString() : "—"}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground/60">
            {models?.fromMock ? "registry unreachable · mock" : "from /v1/models"}
          </div>
        </StatCard>

        <StatCard label="Providers" loading={loading}>
          <div className="font-mono text-2xl tracking-tight tabular-nums">
            {models ? models.providers.toLocaleString() : "—"}
          </div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground/60">
            distinct upstreams · derived from /v1/models
          </div>
        </StatCard>

        <StatCard label="Version" loading={loading}>
          <div className="font-mono text-2xl tracking-tight">v{health?.version ?? "—"}</div>
          <div className="mt-1 font-mono text-[11px] text-muted-foreground/60">
            Hono + Bun · GET /health
          </div>
        </StatCard>
      </div>

      {err ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-mono text-xs text-destructive">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="truncate">{err}</span>
          <button
            type="button"
            onClick={load}
            className="ml-auto inline-flex shrink-0 items-center gap-1 text-foreground/80 hover:text-foreground"
          >
            <RefreshCw className="size-3" /> retry
          </button>
        </div>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-[1.2fr_0.8fr]">
        <Card className="bg-card">
          <CardContent className="p-4">
            <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
              Request pipeline
            </h2>
            <ol className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {PIPELINE.map((p) => (
                <li key={p.stage} className="flex items-baseline gap-2 border-b border-border/60 pb-2 text-[13px] last:border-0 sm:last:border-b">
                  <GitBranch className="size-3.5 shrink-0 translate-y-px text-muted-foreground/40" />
                  <span className="font-mono text-foreground/90">{p.stage}</span>
                  <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">{p.note}</span>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        <Card className="bg-card">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
                Endpoint
              </h2>
              <Link
                to="/playground"
                className="inline-flex items-center gap-1 text-[12px] text-foreground/80 hover:text-foreground"
              >
                open playground <ArrowRight className="size-3" />
              </Link>
            </div>
            <button
              type="button"
              onClick={copy}
              className="mt-3 flex w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-foreground/90 hover:border-muted-foreground/40"
              title="Copy base URL"
            >
              <span className="truncate">{base}/v1</span>
              {copied ? <Check className="size-3.5 shrink-0 text-live" /> : <Copy className="size-3.5 shrink-0 text-muted-foreground/60" />}
            </button>
            <p className="mt-2 font-mono text-[11px] leading-relaxed text-muted-foreground/60">
              auth: <span className="text-foreground/70">Authorization: Bearer $LMNTEA_API_KEY</span>
            </p>
            <div className="mt-3 flex items-center gap-2 rounded-md border border-border/60 bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground/60">
              <Activity className="size-3.5 shrink-0" />
              no key set? add one in your <span className="text-foreground/70">.env</span> and restart
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
