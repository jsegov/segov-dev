"use client"

import { useState, useEffect } from "react"
import { Navbar } from "@/components/navbar"

export default function DebugPage() {
  const [testResult, setTestResult] = useState<string>("Testing API...")
  const [postResult, setPostResult] = useState<string>("Not tested yet")
  const [isLoading, setIsLoading] = useState(true)

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

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-8">
        <div className="terminal-container">
          <h1 className="text-xl font-bold mb-4">API Debug Page</h1>

          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-2">GET /api/test</h2>
            <div className="bg-terminal-black/30 p-4 rounded-md overflow-x-auto">
              <pre className="text-terminal-text">{isLoading ? "Loading..." : testResult}</pre>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-2">POST /api/test</h2>
            <div className="bg-terminal-black/30 p-4 rounded-md overflow-x-auto">
              <pre className="text-terminal-text">{isLoading ? "Loading..." : postResult}</pre>
            </div>
          </div>

          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-2">Test Chatbot API</h2>
            <TestChatbotAPI />
          </div>
        </div>
      </div>
    </div>
  )
}

function TestChatbotAPI() {
  const [result, setResult] = useState<string>("Not tested yet")
  const [isLoading, setIsLoading] = useState(false)
  const [testQuestion, setTestQuestion] = useState("What do you do for work?")

  async function runTest() {
    setIsLoading(true)
    setResult("Testing...")

    try {
      const response = await fetch("/api/chatbot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ question: testQuestion }),
      })

      const responseInfo = {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
      }

      const responseText = await response.text()

      setResult(
        JSON.stringify(
          {
            responseInfo,
            responseText: responseText.substring(0, 500) + (responseText.length > 500 ? "..." : ""),
            fullLength: responseText.length,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      console.error("Chatbot test error:", error)
      setResult(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div>
      <div className="flex gap-4 mb-4">
        <input
          type="text"
          value={testQuestion}
          onChange={(e) => setTestQuestion(e.target.value)}
          placeholder="Enter test question"
          className="flex-1 bg-terminal-black/30 border border-terminal-text/30 rounded-md px-3 py-2"
        />
        <button
          onClick={runTest}
          disabled={isLoading}
          className="px-4 py-2 bg-terminal-black border border-terminal-text/30 rounded-md hover:bg-terminal-text/10"
        >
          {isLoading ? "Testing..." : "Test"}
        </button>
      </div>
      <div className="bg-terminal-black/30 p-4 rounded-md overflow-x-auto">
        <pre className="text-terminal-text">{result}</pre>
      </div>
    </div>
  )
}
