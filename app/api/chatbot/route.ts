import { NextResponse } from "next/server"
import OpenAI from "openai"
import { CareerEntry, ProjectEntry } from "@/lib/content"

// Configure OpenAI client with custom baseURL support for GKE vLLM endpoint
// Defaults to OpenAI's official API when OPENAI_BASE_URL is not set
// Note: OpenAI SDK automatically appends /v1 to baseURL, so OPENAI_BASE_URL should NOT include /v1
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'EMPTY',
  baseURL: process.env.OPENAI_BASE_URL || undefined, // undefined defaults to OpenAI's official API
})

// Determine which model to use based on configuration
const useCoreweave = !!process.env.OPENAI_BASE_URL
const MODEL_ID = process.env.LLM_MODEL_ID || (useCoreweave ? 'Qwen/Qwen3-8B-FP8' : 'gpt-4o')

// Format career entries from Contentful
function formatCareerData(careerEntries: CareerEntry[] | undefined): string {
  if (!careerEntries || !careerEntries.length) return "";
  
  let context = "\nCURRENT CAREER DATA FROM CONTENTFUL:\n\n";
  careerEntries.forEach((entry: CareerEntry) => {
    const duration = entry.endDate 
      ? `${entry.startDate} to ${entry.endDate}` 
      : `${entry.startDate} to Present`;
    
    context += `- ${entry.title} at ${entry.companyName} (${duration})\n`;
    context += `  ${entry.description}\n\n`;
  });
  
  return context;
}

// Format project entries from Contentful
function formatProjectData(projectEntries: ProjectEntry[] | undefined): string {
  if (!projectEntries || !projectEntries.length) return "";
  
  let context = "\nCURRENT PROJECT DATA FROM CONTENTFUL:\n\n";
  projectEntries.forEach((entry: ProjectEntry) => {
    context += `- ${entry.name}\n`;
    context += `  ${entry.description}\n`;
    if (entry.skills && entry.skills.length) {
      context += `  Technologies: ${entry.skills.join(', ')}\n`;
    }
    if (entry.githubUrl) {
      context += `  GitHub: ${entry.githubUrl}\n`;
    }
    context += '\n';
  });
  
  return context;
}

// Get safe base URL for internal API calls
function getSafeBaseUrl(req: Request): string {
  // Use environment variable if available (recommended for production)
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL;
  }
  
  // Fallback to constructing from request, but validate the host
  const host = req.headers.get('host') || 'localhost:3000';
  
  // Validate host to prevent header injection
  const allowedHosts = [
    'localhost:3000',
    'localhost:3001', 
    process.env.VERCEL_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL
  ].filter(Boolean);
  
  if (!allowedHosts.some(allowedHost => host === allowedHost || host.endsWith(`.${allowedHost}`))) {
    console.warn(`[CHATBOT API] Potentially unsafe host header: ${host}`);
    // Default to localhost for development
    return process.env.NODE_ENV === 'production' ? 'https://localhost' : 'http://localhost:3000';
  }
  
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

// System prompt for the chatbot
const systemPrompt = `
You are a terminal-based AI assistant for Jonathan Segovia's personal website.

INSTRUCTIONS:
1. You MUST ONLY answer questions related to Jonathan Segovia.
2. If asked about topics not related to Jonathan Segovia, respond with: "Error: Query outside permitted scope. This terminal only responds to questions about Jonathan Segovia."
3. Format your responses like terminal output, using plain text without markdown.
4. Keep responses concise and focused.
5. You may use simple ASCII formatting like dashes, asterisks, and pipe characters for structure.
`

export async function POST(req: Request) {
  console.log("[CHATBOT API] Received request")

  try {
    // Parse the request body
    const body = await req.json()
    console.log("[CHATBOT API] Request body:", body)

    const { question } = body

    // Validate the question
    if (!question || typeof question !== "string") {
      console.log("[CHATBOT API] Invalid question format:", question)
      return NextResponse.json({ error: "Invalid question format" }, { status: 400 })
    }

    // Check if OpenAI API key is configured (always required, even for self-hosted endpoints)
    if (!process.env.OPENAI_API_KEY) {
      console.error("[CHATBOT API] Missing OPENAI_API_KEY (required for all API configurations)")
      return new Response(
        "Error: API configuration issue. Please contact the site administrator.",
        { status: 500 },
      )
    }
    
    // Get safe base URL for internal API calls
    const baseUrl = getSafeBaseUrl(req);
    
    // Fetch career data from API with ISR
    let careerContext = "";
    try {
      const careerApiUrl = `${baseUrl}/api/context/career`;
      
      const res = await fetch(careerApiUrl);
      if (res.ok) {
        const data = await res.json();
        careerContext = formatCareerData(data.careerEntries);
      } else {
        console.warn("[CHATBOT API] Failed to fetch career data:", await res.text());
      }
    } catch (fetchError) {
      console.error("[CHATBOT API] Error fetching career data:", fetchError);
    }
    
    // Fetch project data from API with ISR
    let projectContext = "";
    try {
      const projectApiUrl = `${baseUrl}/api/context/project`;
      
      const res = await fetch(projectApiUrl);
      if (res.ok) {
        const data = await res.json();
        projectContext = formatProjectData(data.projectEntries);
      } else {
        console.warn("[CHATBOT API] Failed to fetch project data:", await res.text());
      }
    } catch (fetchError) {
      console.error("[CHATBOT API] Error fetching project data:", fetchError);
    }
    
    // Enhance system prompt with career and project data
    const enhancedPrompt = systemPrompt + careerContext + projectContext;

    console.log("[CHATBOT API] Making OpenAI streaming call")

    try {
      // Use OpenAI SDK streaming chat completions
      const stream = await openai.chat.completions.create({
        model: MODEL_ID,
        messages: [
          { role: "system", content: enhancedPrompt },
          { role: "user", content: question },
        ],
        temperature: 0.7,
        max_tokens: 500,
        stream: true,
      })

      console.log("[CHATBOT API] Streaming response with OpenAI SDK")

      // Convert OpenAI stream to plain text stream (compatible with response.text())
      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || ''
              if (content) {
                // Send plain text chunks
                controller.enqueue(encoder.encode(content))
              }
            }
            controller.close()
          } catch (streamError) {
            console.error("[CHATBOT API] Stream error:", streamError)
            controller.error(streamError)
          }
        },
      })

      return new Response(readable, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    } catch (aiError) {
      console.error("[CHATBOT API] OpenAI API error:", aiError)

      // Return a specific error for API issues
      return new Response(
        `segov@terminal:~$ echo "Error: API service unavailable"
Error: API service unavailable. Please try again later.`,
        { status: 503 },
      )
    }
  } catch (error) {
    console.error("[CHATBOT API] General error:", error)

    // Return a generic error message
    return new Response(
      `segov@terminal:~$ echo "Error: Something went wrong"
Error: Something went wrong. Please try again later.`,
      { status: 500 },
    )
  }
}
