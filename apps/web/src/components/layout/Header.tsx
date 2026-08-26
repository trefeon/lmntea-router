import { Menu, Copy, Eye, EyeOff } from "lucide-react"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { useIsMobile } from "@/hooks/use-mobile"

export function Header({
  onMenuClick,
}: {
  onMenuClick: () => void
}) {
  const isMobile = useIsMobile()
  const [revealed, setRevealed] = useState(false)

  return (
    <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/80 px-3 md:px-4">
      {/* left: brand + health */}
      <div className="flex items-center gap-3 min-w-0">
        {isMobile ? (
          <Button variant="ghost" size="icon" aria-label="Open sidebar" onClick={onMenuClick} className="shrink-0">
            <Menu className="size-4" />
          </Button>
        ) : null}

        <div className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-foreground text-background text-sm font-black shrink-0">
            ◐
          </span>
          <span className="hidden sm:inline">lmntea-router</span>
          <span className="hidden sm:inline-flex rounded-full border bg-muted px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
            v0.1.0 · Hono
          </span>
          <span className="hidden md:inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
            <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]" />
            HEALTHY
          </span>
        </div>

        <div className="hidden lg:flex items-center gap-2">
          <select
            aria-label="model"
            defaultValue="oc/x-preview-f-free"
            className="h-8 rounded-lg border bg-card px-2.5 text-sm text-foreground"
          >
            <option>oc/x-preview-f-free</option>
            <option>oc/muse-spark-1.2-contributor-free</option>
            <option>openrouter/auto</option>
          </select>
        </div>
      </div>

      {/* right: base url + api key */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          className="hidden sm:inline-flex gap-1.5 bg-card"
          onClick={() => navigator.clipboard.writeText("http://localhost:8787/v1")}
        >
          <Copy className="size-3.5" />
          <span className="hidden lg:inline">Copy Base URL</span>
          <span className="lg:hidden">Copy URL</span>
        </Button>

        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 bg-card font-mono text-xs"
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          {revealed ? "sk-••••••••" : "••••••••"}
          <span className="hidden sm:inline">{revealed ? "Hide" : "Reveal"}</span>
        </Button>
      </div>
    </header>
  )
}
