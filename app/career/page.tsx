import type { Metadata } from "next"
import { Navbar } from "@/components/navbar"
import { getCareerEntries, type CareerEntry } from "@/lib/contentful"
import { format } from "date-fns"

export const metadata: Metadata = {
  title: "Career | Jonathan Segovia",
  description: "Professional journey and experience of Jonathan Segovia",
}

export const revalidate = 86400 // Revalidate every 24 hours

export default async function CareerPage() {
  let careerEntries: CareerEntry[] = []
  let error = null

  try {
    console.log("[CareerPage] Fetching career entries")
    careerEntries = await getCareerEntries()
    console.log(`[CareerPage] Retrieved ${careerEntries.length} career entries`)
  } catch (err) {
    console.error("[CareerPage] Failed to fetch career entries:", err)
    error = "Failed to load career data. Please check your Contentful configuration."
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="container mx-auto px-4 py-12">
        <div className="terminal-container max-w-4xl mx-auto">
          <div className="terminal-header">
            <h1 className="terminal-title">Career</h1>
          </div>

          <div className="terminal-line">
            <span className="terminal-command">$ cat career.json</span>
          </div>

          {error ? (
            <div className="mt-8 p-4 border border-red-500/30 bg-red-500/10 text-red-400 rounded">
              <p>{error}</p>
              <p className="mt-2 text-sm">
                Make sure you've set up the required environment variables:
                <ul className="list-disc list-inside mt-1">
                  <li>CONTENTFUL_SPACE_ID</li>
                  <li>CONTENTFUL_ACCESS_TOKEN</li>
                  <li>CONTENTFUL_ENVIRONMENT (optional)</li>
                </ul>
              </p>
            </div>
          ) : careerEntries.length === 0 ? (
            <div className="mt-8 p-4 border border-terminal-text/30 rounded">
              <p>No career entries found. Add some content in your Contentful space.</p>
            </div>
          ) : (
            <div className="mt-8 space-y-8">
              {careerEntries.map((entry, index) => {
                const startDate = new Date(entry.startDate)
                const endDate = entry.endDate ? new Date(entry.endDate) : null

                return (
                  <div key={index} className="border border-terminal-green/30 rounded p-6 bg-terminal-black/30">
                    <div className="flex flex-col md:flex-row md:justify-between md:items-start mb-3">
                      <h2 className="text-2xl font-bold">{entry.title}</h2>
                      <div className="text-sm text-terminal-text/70">
                        {format(startDate, "MMM yyyy")} - {endDate ? format(endDate, "MMM yyyy") : "Present"}
                      </div>
                    </div>
                    <div className="text-lg mb-4">{entry.companyName}</div>
                    <p className="text-terminal-green/90 mb-4">{entry.description}</p>
                    
                    {entry.skills && entry.skills.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {entry.skills.map((skill, skillIndex) => (
                          <span
                            key={skillIndex}
                            className="text-xs px-2 py-1 bg-terminal-black border border-terminal-green/30 rounded"
                          >
                            {skill}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
