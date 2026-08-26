import { useState } from "react"
import { Outlet } from "react-router-dom"

import { Header } from "./Header"
import { Sidebar } from "./Sidebar"

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <Header onMenuClick={() => setSidebarOpen((v) => !v)} />
      <div className="flex min-h-[calc(100vh-56px)]">
        <Sidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
        <main className="flex-1 min-w-0 bg-background">
          <div className="mx-auto w-full max-w-[1280px] p-4 md:p-5">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
