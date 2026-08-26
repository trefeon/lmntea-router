import { useEffect } from "react"
import { BrowserRouter, Routes, Route } from "react-router-dom"

import { Layout } from "@/components/layout/Layout"
import { TooltipProvider } from "@/components/ui/tooltip"

import Dashboard from "@/pages/Dashboard"
import Providers from "@/pages/Providers"
import ProxyPools from "@/pages/ProxyPools"
import Models from "@/pages/Models"
import Combos from "@/pages/Combos"
import Usage from "@/pages/Usage"
import Playground from "@/pages/Playground"

export default function App() {
  useEffect(() => {
    // Vercel black/white zinc is dark-first — ensure dark class on html
    document.documentElement.classList.add("dark")
  }, [])

  return (
    <TooltipProvider delay={100}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/providers" element={<Providers />} />
            <Route path="/proxy-pools" element={<ProxyPools />} />
            <Route path="/models" element={<Models />} />
            <Route path="/combos" element={<Combos />} />
            <Route path="/usage" element={<Usage />} />
            <Route path="/playground" element={<Playground />} />
            {/* fallback: unknown routes show dashboard to avoid 404 */}
            <Route path="*" element={<Dashboard />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  )
}
