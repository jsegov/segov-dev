"use client"

import { useState, useEffect } from "react"
import { Navbar } from "@/components/navbar"

interface CredentialsCheck {
  success: boolean
  error?: string
  spaceInfo?: {
    id: string
    name: string
    environment: string
  }
  configuredCredentials: {
    spaceId: string
    environment: string
    accessTokenConfigured: boolean
    previewTokenConfigured: boolean
  }
}

export default function EntryDebugPage() {
  const [entryId, setEntryId] = useState<string>("5XEsr9nujbp3U1BvV6nJqS") // Default to the ID from the curl command
  const [entry, setEntry] = useState<any>(null)
  const [credentialsCheck, setCredentialsCheck] = useState<CredentialsCheck | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [curlCommand, setCurlCommand] = useState<any>(null)

  // Fetch entry on initial load
  useEffect(() => {
    fetchEntry()
  }, [])

  const fetchEntry = async () => {
    setLoading(true)
    setError(null)
    setEntry(null)

    try {
      const response = await fetch(`/api/debug/entry?id=${entryId}`)

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setEntry(data.entry)
      setCredentialsCheck(data.credentialsCheck)
      setCurlCommand(data.curlCommand)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred")
      console.error("Error fetching entry:", err)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-8">
        <div className="terminal-container">
          <h1 className="text-xl font-bold mb-4">Contentful Entry Debug</h1>

          <div className="mb-6">
            <div className="flex items-end gap-2 mb-4">
              <div className="flex-1">
                <label htmlFor="entry-id" className="block text-sm mb-1">
                  Entry ID
                </label>
                <input
                  id="entry-id"
                  type="text"
                  value={entryId}
                  onChange={(e) => setEntryId(e.target.value)}
                  className="w-full bg-terminal-black/30 border border-terminal-text/30 rounded px-3 py-2"
                />
              </div>
              <button
                onClick={fetchEntry}
                disabled={loading}
                className="px-4 py-2 bg-terminal-black border border-terminal-text/30 rounded hover:bg-terminal-text/10"
              >
                {loading ? "Loading..." : "Fetch Entry"}
              </button>
            </div>

            <div className="bg-terminal-black/30 p-4 rounded">
              <h2 className="text-lg font-semibold mb-2">Curl Command Reference</h2>
              <pre className="text-xs overflow-x-auto p-2 bg-terminal-black/50 rounded">
                {`curl --include \\
     --request GET \\
     https://cdn.contentful.com/spaces/2n0vhc7pqwso/environments/master/entries/5XEsr9nujbp3U1BvV6nJqS?access_token=tWYXSjpOMn1Y6uxoUk6tkrEwlhVkcZbvQC4yKJq3kk8`}
              </pre>
            </div>
          </div>

          {loading ? (
            <div className="text-center py-8">
              <p>Loading entry data...</p>
            </div>
          ) : error ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded">
              <p>Error: {error}</p>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Credentials Check */}
              {credentialsCheck && (
                <div className="bg-terminal-black/30 p-4 rounded">
                  <h2 className="text-lg font-semibold mb-2">Credentials Check</h2>

                  {credentialsCheck.success ? (
                    <div className="bg-green-500/10 border border-green-500/30 text-green-400 p-3 rounded mb-4">
                      <p>✓ Credentials verified successfully</p>
                    </div>
                  ) : (
                    <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-3 rounded mb-4">
                      <p>✗ Credentials verification failed: {credentialsCheck.error}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {credentialsCheck.spaceInfo && (
                      <div className="bg-terminal-black/20 p-3 rounded">
                        <h3 className="font-medium mb-2">Space Information</h3>
                        <p>
                          ID: <code>{credentialsCheck.spaceInfo.id}</code>
                        </p>
                        <p>Name: {credentialsCheck.spaceInfo.name}</p>
                        <p>
                          Environment: <code>{credentialsCheck.spaceInfo.environment}</code>
                        </p>
                      </div>
                    )}

                    <div className="bg-terminal-black/20 p-3 rounded">
                      <h3 className="font-medium mb-2">Configured Credentials</h3>
                      <p>
                        Space ID: <code>{credentialsCheck.configuredCredentials.spaceId}</code>
                      </p>
                      <p>
                        Environment: <code>{credentialsCheck.configuredCredentials.environment}</code>
                      </p>
                      <p>
                        Access Token:{" "}
                        {credentialsCheck.configuredCredentials.accessTokenConfigured ? "✓ Configured" : "✗ Missing"}
                      </p>
                      <p>
                        Preview Token:{" "}
                        {credentialsCheck.configuredCredentials.previewTokenConfigured ? "✓ Configured" : "✗ Missing"}
                      </p>
                    </div>
                  </div>

                  {curlCommand && (
                    <div className="mt-4 bg-terminal-black/20 p-3 rounded">
                      <h3 className="font-medium mb-2">Curl Command Configuration</h3>
                      <p>
                        Space ID: <code>{curlCommand.spaceId}</code>
                      </p>
                      <p>
                        Environment: <code>{curlCommand.environment}</code>
                      </p>
                      <p>
                        Entry ID: <code>{curlCommand.entryId}</code>
                      </p>
                      <p>
                        Access Token: <code>{curlCommand.accessToken}</code>
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* Entry Data */}
              {entry ? (
                <div className="bg-terminal-black/30 p-4 rounded">
                  <h2 className="text-lg font-semibold mb-2">Entry Data</h2>

                  <div className="mb-4">
                    <h3 className="font-medium mb-1">System Information</h3>
                    <div className="bg-terminal-black/20 p-3 rounded text-sm">
                      <p>
                        ID: <code>{entry.sys.id}</code>
                      </p>
                      <p>
                        Content Type: <code>{entry.sys.contentType.sys.id}</code>
                      </p>
                      <p>Created: {new Date(entry.sys.createdAt).toLocaleString()}</p>
                      <p>Updated: {new Date(entry.sys.updatedAt).toLocaleString()}</p>
                      <p>Published: {new Date(entry.sys.publishedAt).toLocaleString()}</p>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-medium mb-1">Fields</h3>
                    <div className="bg-terminal-black/20 p-3 rounded">
                      <pre className="text-xs overflow-x-auto">{JSON.stringify(entry.fields, null, 2)}</pre>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="bg-terminal-black/30 p-4 rounded text-center">
                  <p>No entry data available. Try fetching the entry.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
