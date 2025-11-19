"use client"

import { useEffect, useState } from "react"
import { Analytics as VercelAnalytics } from "@vercel/analytics/react"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"

export function Analytics() {
  const [analyticsEnabled, setAnalyticsEnabled] = useState<boolean>(false)
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
    const storedPreference = localStorage.getItem("analytics-enabled")
    if (storedPreference !== null) {
      setAnalyticsEnabled(storedPreference === "true")
    }
  }, [])

  const handleToggleAnalytics = (checked: boolean) => {
    setAnalyticsEnabled(checked)
    localStorage.setItem("analytics-enabled", String(checked))
  }

  // Don't render until component is mounted to prevent hydration mismatch
  if (!isMounted) {
    return null
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-card border border-border/30 rounded-md p-2 text-xs text-muted-foreground shadow-lg">
      <div className="flex items-center space-x-2">
        <Switch id="analytics-mode" checked={analyticsEnabled} onCheckedChange={handleToggleAnalytics} />
        <Label htmlFor="analytics-mode">Analytics</Label>
      </div>
      {analyticsEnabled && <VercelAnalytics />}
    </div>
  )
}
