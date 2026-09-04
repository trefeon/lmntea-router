import { useState } from "react"
import { Outlet } from "react-router-dom"

import { Header } from "./Header"
import { Sidebar } from "./Sidebar"

export function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)

  return (
    <div className="min-h-screen bg-background text-foreground">
      <Header onMenuClick={() => setSidebarOpen((v) => !v)} />
      <div className="flex min-h-[calc(100vh-56px)]">
        <Sidebar open={sidebarOpen} onOpenChange={setSidebarOpen} />
        <main className="min-w-0 flex-1 bg-background">
          <div className="mx-auto w-full max-w-[1280px] p-4 md:p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
