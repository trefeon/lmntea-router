import { NavLink } from "react-router-dom"
import {
  BarChart3,
  Grid3x3,
  Hexagon,
  LayoutDashboard,
  MessageSquare,
  Network,
  Plug,
  Radar,
  ScrollText,
  Settings,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"

type NavItem = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
  badge?: string
  disabled?: boolean
}

type NavGroup = {
  title: string
  items: NavItem[]
}

// 9 nav items from 06-WIREFRAMES.md + Playground (new route) = 10 rendered
// Wireframe groups: Overview(1) + Providers&Routing(4) + Intelligence(1) + Observability(2+playground) + System(1)
const NAV_GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    title: "Providers & Routing",
    items: [
      { to: "/providers", label: "Providers", icon: Plug, badge: "6 Active" },
      { to: "/models", label: "Models", icon: Grid3x3, badge: "419" },
      { to: "/proxy-pools", label: "Proxy Pools", icon: Network, badge: "6 Vercel" },
      { to: "/combos", label: "Combos", icon: Hexagon, badge: "4" },
    ],
  },
  {
    title: "Intelligence",
    items: [{ to: "/models", label: "Radar", icon: Radar, badge: "soon" }],
  },
  {
    title: "Observability",
    items: [
      { to: "/playground", label: "Playground", icon: MessageSquare },
      { to: "/usage", label: "Usage", icon: BarChart3 },
      { to: "#logs", label: "Logs", icon: ScrollText, disabled: true },
    ],
  },
  {
    title: "System",
    items: [{ to: "#settings", label: "Settings", icon: Settings, disabled: true }],
  },
]

function NavItemLink({ item }: { item: NavItem }) {
  if (item.disabled) {
    return (
      <span
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-muted-foreground opacity-60",
          "border-l-2 border-transparent"
        )}
        aria-disabled="true"
        title="Coming soon"
      >
        <item.icon className="size-4 shrink-0" />
        <span className="truncate">{item.label}</span>
        {item.badge ? (
          <span className="ml-auto rounded-full border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {item.badge}
          </span>
        ) : null}
      </span>
    )
  }

  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors",
          "border-l-2",
          isActive
            ? "border-primary bg-card text-foreground font-medium"
            : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground"
        )
      }
    >
      <item.icon className="size-4 shrink-0" />
      <span className="truncate">{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-full border bg-muted px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {item.badge}
        </span>
      ) : null}
    </NavLink>
  )
}

export function Sidebar({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isMobile = useIsMobile()

  // Height: 56px topbar offset, sticky sidebar
  const sidebarContent = (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-2.5 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <h4 className="px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
            {group.title}
          </h4>
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <NavItemLink key={`${group.title}-${item.label}`} item={item} />
            ))}
          </div>
        </div>
      ))}

      <div className="mt-auto border-t pt-4 px-2.5">
        <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
          <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.15)]" />
          <span>
            Health{" "}
            <a href="/health" className="underline decoration-muted-foreground/30 hover:text-foreground">
              /health
            </a>{" "}
            · OK
          </span>
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          lmntea-router · zinc-950 · Vercel black/white
        </div>
      </div>
    </div>
  )

  if (isMobile) {
    if (!open) return null
    return (
      <div className="fixed inset-0 z-40 flex">
        {/* backdrop */}
        <button
          type="button"
          aria-label="Close sidebar"
          className="flex-1 bg-black/60 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        />
        {/* drawer */}
        <aside className="fixed inset-y-0 left-0 z-50 w-[280px] border-r bg-background shadow-xl">
          <div className="flex h-14 items-center border-b px-4">
            <div className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-flex size-7 items-center justify-center rounded-lg bg-foreground text-background text-sm font-black">
                ◐
              </span>
              lmntea-router
              <span className="rounded-full border bg-muted px-2 py-0.5 font-mono text-[10px] leading-none text-muted-foreground">
                v0.1.0
              </span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="ml-auto rounded-md border bg-card px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            >
              ✕
            </button>
          </div>
          {sidebarContent}
        </aside>
      </div>
    )
  }

  // Desktop: 220px fixed, sticky below 56px topbar
  return (
    <aside className="hidden w-[220px] shrink-0 border-r bg-background md:flex md:flex-col sticky top-14 h-[calc(100vh-56px)]">
      {sidebarContent}
    </aside>
  )
}
