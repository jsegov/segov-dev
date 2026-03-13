"use client"

import { useState, useEffect } from "react"
import { Navbar } from "@/components/navbar"

export default function DebugPage() {
  const [testResult, setTestResult] = useState<string>("Testing API...")
  const [postResult, setPostResult] = useState<string>("Not tested yet")
  const [isLoading, setIsLoading] = useState(true)
  const [loadingHealth, setLoadingHealth] = useState(false)
  const [apiHealth, setApiHealth] = useState<string>("Not checked yet")

  useEffect(() => {
    async function testAPI() {
      try {
        // Test GET endpoint
        const getResponse = await fetch("/api/test")
        const getData = await getResponse.json()
        setTestResult(JSON.stringify(getData, null, 2))

        // Test POST endpoint
        const postResponse = await fetch("/api/test", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ test: "data" }),
        })
        const postData = await postResponse.json()
        setPostResult(JSON.stringify(postData, null, 2))
      } catch (error) {
        console.error("API test error:", error)
        setTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        setIsLoading(false)
      }
    }

    testAPI()
  }, [])

  async function checkHealth() {
    setLoadingHealth(true)
    setApiHealth("Checking...")
    try {
      const response = await fetch("/api/health")
      const data = await response.json()
      setApiHealth(JSON.stringify(data, null, 2))
    } catch (error) {
      console.error("Health check error:", error)
      setApiHealth(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setLoadingHealth(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-8">
        <div className="terminal-container">
          <h1 className="text-xl font-bold mb-4">API Debug Page</h1>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
            <div className="border border-border/30 rounded p-6 bg-card">
              <h2 className="text-lg font-semibold mb-2">API Health Check</h2>
              <p className="text-muted-foreground mb-4">
                <span className="text-muted-foreground">API URL:</span> {process.env.NEXT_PUBLIC_API_URL || '(not set)'}
              </p>
              <p className="text-muted-foreground mb-4">
                <span className="text-muted-foreground">NODE_ENV:</span> {process.env.NODE_ENV}
              </p>
              <button
                onClick={checkHealth}
                disabled={loadingHealth}
                className="px-4 py-2 bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
              >
                {loadingHealth ? 'Checking...' : 'Check API Health'}
              </button>
              <div className="bg-background/30 p-4 rounded-md overflow-x-auto mt-4">
                <pre className="text-terminal-text">{apiHealth}</pre>
              </div>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-2">GET /api/test</h2>
            <div className="bg-background/30 p-4 rounded-md overflow-x-auto">
              <pre className="text-terminal-text">{isLoading ? "Loading..." : testResult}</pre>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-2">POST /api/test</h2>
            <div className="bg-background/30 p-4 rounded-md overflow-x-auto">
              <pre className="text-terminal-text">{isLoading ? "Loading..." : postResult}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
