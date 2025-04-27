import { type NextRequest, NextResponse } from "next/server"
import { getCareerEntries, getProjects, getBlogPosts } from "@/lib/contentful"

// In-memory log storage (will be cleared on server restart)
const logs: any[] = []

// Custom console logger to capture logs
const originalConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
}

// Override console methods to capture Contentful logs
function setupLogCapture() {
  console.log = (...args) => {
    originalConsole.log(...args)
    captureLog("info", args)
  }

  console.warn = (...args) => {
    originalConsole.warn(...args)
    captureLog("warn", args)
  }

  console.error = (...args) => {
    originalConsole.error(...args)
    captureLog("error", args)
  }

  console.debug = (...args) => {
    originalConsole.debug(...args)
    captureLog("debug", args)
  }
}

// Restore original console methods
function restoreConsole() {
  console.log = originalConsole.log
  console.warn = originalConsole.warn
  console.error = originalConsole.error
  console.debug = originalConsole.debug
}

// Capture log entries
function captureLog(level: string, args: any[]) {
  if (args.length > 0 && typeof args[0] === "string") {
    const message = args[0]

    // Only capture Contentful logs
    if (message.includes("[Contentful]")) {
      const logEntry = {
        timestamp: new Date().toISOString(),
        level: message.includes("ERROR")
          ? "error"
          : message.includes("WARNING")
            ? "warn"
            : message.includes("PERFORMANCE")
              ? "performance"
              : message.includes("DEBUG")
                ? "debug"
                : "info",
        message: message.replace(/\[Contentful\] (INFO|ERROR|WARNING|DEBUG|PERFORMANCE): /, ""),
        data: args.length > 1 ? args[1] : undefined,
      }

      logs.push(logEntry)

      // Keep only the last 100 logs
      if (logs.length > 100) {
        logs.shift()
      }
    }
  }
}

export async function GET(request: NextRequest) {
  // Check if this is a development environment
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Debug endpoints are only available in development mode" }, { status: 403 })
  }

  // Clear previous logs
  logs.length = 0

  // Get query parameters
  const searchParams = request.nextUrl.searchParams
  const type = searchParams.get("type") || "career"

  try {
    // Setup log capture
    setupLogCapture()

    // Fetch data based on type parameter
    if (type === "career") {
      await getCareerEntries()
    } else if (type === "projects") {
      await getProjects()
    } else if (type === "blog") {
      await getBlogPosts()
    } else {
      throw new Error(`Invalid content type: ${type}`)
    }

    // Return captured logs
    return NextResponse.json({ logs, type })
  } catch (error) {
    console.error("Error in debug API:", error)
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error", logs }, { status: 500 })
  } finally {
    // Restore original console methods
    restoreConsole()
  }
}
