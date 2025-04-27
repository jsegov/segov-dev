"use client"

import { useState, useEffect } from "react"
import { Navbar } from "@/components/navbar"

interface LogEntry {
  timestamp: string
  level: "info" | "warn" | "error" | "debug" | "performance"
  message: string
  data?: any
}

export default function ContentfulDebugPage() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<"career" | "projects" | "blog">("career")

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(`/api/debug/contentful?type=${activeTab}`)

        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        setLogs(data.logs || [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error occurred")
        console.error("Error fetching debug data:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [activeTab])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-8">
        <div className="terminal-container">
          <h1 className="text-xl font-bold mb-4">Contentful Debug Console</h1>

          <div className="mb-4 flex space-x-2">
            <button
              onClick={() => setActiveTab("career")}
              className={`px-3 py-1 rounded ${activeTab === "career" ? "bg-terminal-text text-terminal-black" : "bg-terminal-black/30 text-terminal-text"}`}
            >
              Career Entries
            </button>
            <button
              onClick={() => setActiveTab("projects")}
              className={`px-3 py-1 rounded ${activeTab === "projects" ? "bg-terminal-text text-terminal-black" : "bg-terminal-black/30 text-terminal-text"}`}
            >
              Projects
            </button>
            <button
              onClick={() => setActiveTab("blog")}
              className={`px-3 py-1 rounded ${activeTab === "blog" ? "bg-terminal-text text-terminal-black" : "bg-terminal-black/30 text-terminal-text"}`}
            >
              Blog Posts
            </button>
          </div>

          {loading ? (
            <div className="text-center py-8">
              <p>Loading logs...</p>
            </div>
          ) : error ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded">
              <p>Error: {error}</p>
            </div>
          ) : logs.length === 0 ? (
            <div className="bg-terminal-black/30 p-4 rounded text-center">
              <p>No logs available. Try refreshing or checking server console.</p>
            </div>
          ) : (
            <div className="bg-terminal-black/30 p-4 rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-terminal-text/30">
                    <th className="text-left p-2">Time</th>
                    <th className="text-left p-2">Level</th>
                    <th className="text-left p-2">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.map((log, index) => (
                    <tr key={index} className="border-b border-terminal-text/10">
                      <td className="p-2 text-terminal-text/70">{log.timestamp}</td>
                      <td className="p-2">
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${
                            log.level === "error"
                              ? "bg-red-500/20 text-red-400"
                              : log.level === "warn"
                                ? "bg-yellow-500/20 text-yellow-400"
                                : log.level === "info"
                                  ? "bg-blue-500/20 text-blue-400"
                                  : log.level === "performance"
                                    ? "bg-green-500/20 text-green-400"
                                    : "bg-gray-500/20 text-gray-400"
                          }`}
                        >
                          {log.level}
                        </span>
                      </td>
                      <td className="p-2">
                        <div>{log.message}</div>
                        {log.data && (
                          <pre className="mt-1 text-xs bg-terminal-black/50 p-2 rounded overflow-x-auto">
                            {typeof log.data === "object" ? JSON.stringify(log.data, null, 2) : log.data}
                          </pre>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
