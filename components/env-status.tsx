// Create a new component to display environment variable status

import { AlertTriangle } from "lucide-react"

export function EnvStatus() {
  // This component will only run on the server
  const envVars = {
    spaceId: process.env.CONTENTFUL_SPACE_ID,
    accessToken: process.env.CONTENTFUL_ACCESS_TOKEN,
    environment: process.env.CONTENTFUL_ENVIRONMENT,
    previewToken: process.env.CONTENTFUL_PREVIEW_ACCESS_TOKEN,
    previewSecret: process.env.CONTENTFUL_PREVIEW_SECRET,
  }

  const missingVars = Object.entries(envVars)
    .filter(([key, value]) => !value && (key === "spaceId" || key === "accessToken"))
    .map(([key]) => key)

  const isConfigured = missingVars.length === 0

  if (isConfigured) {
    return null
  }

  return (
    <div className="fixed bottom-4 left-4 z-50 max-w-md p-4 bg-terminal-black border border-red-500/30 rounded-md text-sm">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-5 w-5 text-red-400 flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="font-bold text-red-400">Missing Environment Variables</h3>
          <p className="mt-1 text-terminal-green/90">The following required environment variables are missing:</p>
          <ul className="list-disc list-inside mt-1 text-red-400/90">
            {missingVars.map((varName) => (
              <li key={varName}>{varName}</li>
            ))}
          </ul>
          <p className="mt-2 text-terminal-green/90">
            Please add these to your .env.local file or Vercel project settings.
          </p>
        </div>
      </div>
    </div>
  )
}
