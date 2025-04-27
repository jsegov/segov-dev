"use client"

import { useState, useEffect } from "react"
import { Navbar } from "@/components/navbar"

interface ContentTypeField {
  id: string
  name: string
  type: string
  required: boolean
  localized: boolean
}

interface ContentType {
  id: string
  name: string
  displayField: string
  fields: ContentTypeField[]
}

interface EntriesInfo {
  count: number
  sample: {
    id: string
    createdAt: string
    updatedAt: string
    fields: string[]
  } | null
}

export default function ContentTypesDebugPage() {
  const [contentTypes, setContentTypes] = useState<ContentType[]>([])
  const [selectedType, setSelectedType] = useState<string>("")
  const [typeDetails, setTypeDetails] = useState<ContentType | null>(null)
  const [entriesInfo, setEntriesInfo] = useState<EntriesInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Fetch all content types on initial load
  useEffect(() => {
    const fetchContentTypes = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch("/api/debug/content-types")

        if (!response.ok) {
          throw new Error(`API returned ${response.status}: ${response.statusText}`)
        }

        const data = await response.json()
        setContentTypes(data.contentTypes || [])
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error occurred")
        console.error("Error fetching content types:", err)
      } finally {
        setLoading(false)
      }
    }

    fetchContentTypes()
  }, [])

  // Fetch details for a specific content type
  const fetchContentTypeDetails = async (contentTypeId: string) => {
    if (!contentTypeId) return

    setLoading(true)
    setError(null)
    setTypeDetails(null)
    setEntriesInfo(null)

    try {
      const response = await fetch(`/api/debug/content-types?contentType=${contentTypeId}`)

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      setTypeDetails(data.contentType)
      setEntriesInfo(data.entriesInfo)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error occurred")
      console.error(`Error fetching details for content type ${contentTypeId}:`, err)
    } finally {
      setLoading(false)
    }
  }

  // Handle content type selection
  const handleSelectType = (contentTypeId: string) => {
    setSelectedType(contentTypeId)
    fetchContentTypeDetails(contentTypeId)
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-8">
        <div className="terminal-container">
          <h1 className="text-xl font-bold mb-4">Contentful Content Types Debug</h1>

          {loading && !contentTypes.length ? (
            <div className="text-center py-8">
              <p>Loading content types...</p>
            </div>
          ) : error && !contentTypes.length ? (
            <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded">
              <p>Error: {error}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Content Types List */}
              <div className="bg-terminal-black/30 p-4 rounded">
                <h2 className="text-lg font-semibold mb-3">Content Types</h2>

                {contentTypes.length === 0 ? (
                  <p className="text-terminal-text/70">No content types found</p>
                ) : (
                  <ul className="space-y-1">
                    {contentTypes.map((type) => (
                      <li key={type.id}>
                        <button
                          onClick={() => handleSelectType(type.id)}
                          className={`w-full text-left px-2 py-1 rounded ${
                            selectedType === type.id
                              ? "bg-terminal-text text-terminal-black"
                              : "hover:bg-terminal-text/10"
                          }`}
                        >
                          {type.name} <span className="text-terminal-text/50 text-xs">({type.id})</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Content Type Details */}
              <div className="md:col-span-2">
                {loading && selectedType ? (
                  <div className="text-center py-8">
                    <p>Loading details...</p>
                  </div>
                ) : error && selectedType ? (
                  <div className="bg-red-500/10 border border-red-500/30 text-red-400 p-4 rounded">
                    <p>Error: {error}</p>
                  </div>
                ) : typeDetails ? (
                  <div className="space-y-6">
                    <div className="bg-terminal-black/30 p-4 rounded">
                      <h2 className="text-lg font-semibold mb-2">{typeDetails.name}</h2>
                      <div className="text-sm text-terminal-text/70 mb-4">
                        <p>
                          ID: <code>{typeDetails.id}</code>
                        </p>
                        <p>
                          Display Field: <code>{typeDetails.displayField}</code>
                        </p>
                      </div>

                      <h3 className="font-medium mb-2">Fields</h3>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-terminal-text/30">
                            <th className="text-left p-2">ID</th>
                            <th className="text-left p-2">Name</th>
                            <th className="text-left p-2">Type</th>
                            <th className="text-center p-2">Required</th>
                            <th className="text-center p-2">Localized</th>
                          </tr>
                        </thead>
                        <tbody>
                          {typeDetails.fields.map((field) => (
                            <tr key={field.id} className="border-b border-terminal-text/10">
                              <td className="p-2">
                                <code>{field.id}</code>
                              </td>
                              <td className="p-2">{field.name}</td>
                              <td className="p-2">
                                <code>{field.type}</code>
                              </td>
                              <td className="p-2 text-center">
                                {field.required ? (
                                  <span className="text-green-400">✓</span>
                                ) : (
                                  <span className="text-terminal-text/30">-</span>
                                )}
                              </td>
                              <td className="p-2 text-center">
                                {field.localized ? (
                                  <span className="text-green-400">✓</span>
                                ) : (
                                  <span className="text-terminal-text/30">-</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {entriesInfo && (
                      <div className="bg-terminal-black/30 p-4 rounded">
                        <h3 className="font-medium mb-2">Entries</h3>
                        <p className="mb-3">
                          Total entries: <strong>{entriesInfo.count}</strong>
                        </p>

                        {entriesInfo.sample ? (
                          <div>
                            <h4 className="text-sm font-medium mb-1">Sample Entry</h4>
                            <div className="bg-terminal-black/50 p-3 rounded text-xs">
                              <p>
                                ID: <code>{entriesInfo.sample.id}</code>
                              </p>
                              <p>Created: {new Date(entriesInfo.sample.createdAt).toLocaleString()}</p>
                              <p>Updated: {new Date(entriesInfo.sample.updatedAt).toLocaleString()}</p>
                              <p className="mt-2">Fields:</p>
                              <ul className="list-disc list-inside">
                                {entriesInfo.sample.fields.map((field) => (
                                  <li key={field}>
                                    <code>{field}</code>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        ) : (
                          <p className="text-terminal-text/70">No sample entries available</p>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="bg-terminal-black/30 p-8 rounded text-center text-terminal-text/70">
                    <p>Select a content type to view details</p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
