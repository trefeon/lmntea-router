import { Copy } from "lucide-react"
import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"
import { fetchHealth, getApiBase } from "@/lib/api"
import { cn } from "@/lib/utils"

function useHealth() {
  const [state, setState] = useState<{
    status: "ok" | "down" | "loading"
    latencyMs?: number
    version?: string
  }>({ status: "loading" })

  useEffect(() => {
    let alive = true
    const ping = async () => {
      try {
        const h = await fetchHealth()
        if (!alive) return
        setState({ status: h.status === "ok" ? "ok" : "down", latencyMs: h.latencyMs, version: h.version })
      } catch {
        if (alive) setState({ status: "down" })
      }
    }
    ping()
    const t = setInterval(ping, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  return state
}

function StatusDot({ status }: { status: "ok" | "down" | "loading" }) {
  return (
    <span
      className={cn(
        "inline-block size-1.5 rounded-full",
        status === "ok" && "bg-live",
        status === "down" && "bg-destructive",
        status === "loading" && "bg-muted-foreground/50"
      )}
      aria-hidden
    />
  )
}

export function Header({ onMenuClick }: { onMenuClick: () => void }) {
  const isMobile = useIsMobile()
  const [copied, setCopied] = useState(false)
  const health = useHealth()

  const base = getApiBase() || (typeof window !== "undefined" ? window.location.origin : "")
  const endpoint = `${base}/v1`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(endpoint)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable — noop */
    }
  }

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        {isMobile ? (
          <Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={onMenuClick} className="shrink-0">
            <MenuGlyph />
          </Button>
        ) : null}

        <div className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold tracking-tight">lmntea</span>
          <span className="font-mono text-xs text-muted-foreground">router</span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5 bg-card font-mono text-xs" onClick={copy}>
          <Copy className="size-3.5" />
          {copied ? "copied" : "/v1"}
        </Button>

        <div
          className="hidden items-center gap-2 font-mono text-xs text-muted-foreground sm:flex"
          title={health.status === "down" ? "API unreachable" : `latency ${health.latencyMs ?? "—"} ms`}
        >
          <StatusDot status={health.status} />
          <span>
            {health.status === "loading" ? "—" : health.status === "ok" ? (health.latencyMs != null ? `${health.latencyMs}ms` : "ok") : "down"}
          </span>
          {health.version ? <span className="text-muted-foreground/60">v{health.version}</span> : null}
        </div>
      </div>
    </header>
  )
}

function MenuGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}
