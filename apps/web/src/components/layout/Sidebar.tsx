import { BarChart3, Grid3x3, Hexagon, LayoutDashboard, MessageSquare, Network, Plug } from "lucide-react"
import { NavLink } from "react-router-dom"

import { cn } from "@/lib/utils"
import { useIsMobile } from "@/hooks/use-mobile"

type NavItem = {
  to: string
  label: string
  icon: React.ComponentType<{ className?: string }>
}

type NavGroup = {
  title: string
  items: NavItem[]
}

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [{ to: "/", label: "Dashboard", icon: LayoutDashboard }],
  },
  {
    title: "Routing",
    items: [
      { to: "/models", label: "Models", icon: Grid3x3 },
      { to: "/providers", label: "Providers", icon: Plug },
      { to: "/proxy-pools", label: "Proxy Pools", icon: Network },
      { to: "/combos", label: "Combos", icon: Hexagon },
    ],
  },
  {
    title: "Observability",
    items: [
      { to: "/playground", label: "Playground", icon: MessageSquare },
      { to: "/usage", label: "Usage", icon: BarChart3 },
    ],
  },
]

function NavItemLink({ item }: { item: NavItem }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] transition-colors duration-150",
          isActive
            ? "bg-muted font-medium text-foreground"
            : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        )
      }
    >
      <item.icon className="size-4 shrink-0 text-muted-foreground/70" />
      <span className="truncate">{item.label}</span>
    </NavLink>
  )
}

function SidebarContent() {
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-6 overflow-y-auto px-3 py-5">
        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <h4 className="px-2.5 pb-1 font-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
              {group.title}
            </h4>
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <NavItemLink key={item.label} item={item} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-auto border-t px-5 py-3">
        <div className="font-mono text-[11px] text-muted-foreground/60">
          lmntea-router <span className="text-muted-foreground/40">v0.2.0</span>
        </div>
      </div>
    </div>
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

  if (isMobile) {
    if (!open) return null
    return (
      <div className="fixed inset-0 z-40 flex">
        <button
          type="button"
          aria-label="Close sidebar"
          className="flex-1 bg-black/60 backdrop-blur-sm"
          onClick={() => onOpenChange(false)}
        />
        <aside className="fixed inset-y-0 left-0 z-50 w-[260px] border-r bg-background">
          <div className="flex h-14 items-center justify-between border-b px-4">
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] font-semibold tracking-tight">lmntea</span>
              <span className="font-mono text-xs text-muted-foreground">router</span>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-md border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
              aria-label="Close sidebar"
            >
              ✕
            </button>
          </div>
          <div className="h-[calc(100%-3.5rem)]">
            <SidebarContent />
          </div>
        </aside>
      </div>
    )
  }

  return (
    <aside className="sticky top-14 hidden h-[calc(100vh-56px)] w-[220px] shrink-0 border-r bg-background md:flex md:flex-col">
      <SidebarContent />
    </aside>
  )
}
