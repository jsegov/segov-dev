import { NextResponse } from "next/server"
import { streamText } from "ai"
import { openai } from "@ai-sdk/openai"
import { CareerEntry, ProjectEntry } from "@/lib/contentful"

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

    // Check if OpenAI API key is configured
    if (!process.env.OPENAI_API_KEY) {
      console.error("[CHATBOT API] OpenAI API key not configured")
      return new Response(
        "Error: API configuration issue. Please contact the site administrator.",
        { status: 500 },
      )
    }
    
    // Fetch career data from API with ISR
    let careerContext = "";
    try {
      // Construct absolute URL for server-side fetch
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const host = req.headers.get('host') || 'localhost:3000';
      const careerApiUrl = `${protocol}://${host}/api/context/career`;
      
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
      // Construct absolute URL for server-side fetch
      const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
      const host = req.headers.get('host') || 'localhost:3000';
      const projectApiUrl = `${protocol}://${host}/api/context/project`;
      
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

    console.log("[CHATBOT API] Making AI SDK streamText call")

    try {
      // Use streamText from AI SDK to generate text
      const result = await streamText({
        model: openai("gpt-4o"),
        messages: [
          { role: "system", content: enhancedPrompt },
          { role: "user", content: question },
        ],
        temperature: 0.7,
        maxTokens: 500,
      })

      console.log("[CHATBOT API] Streaming response with AI SDK")

      // Return the streaming response using toTextStreamResponse
      return result.toTextStreamResponse()
    } catch (aiError) {
      console.error("[CHATBOT API] AI SDK error:", aiError)

      // Return a specific error for AI SDK issues
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
