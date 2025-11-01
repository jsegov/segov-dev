import { NextResponse } from "next/server"
import OpenAI from "openai"
import { CareerEntry, ProjectEntry, getChatbotPrompt } from "@/lib/content"

const MODEL_ID = process.env.LLM_MODEL_ID || 'gpt-5-nano-2025-08-07'

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

function getSafeBaseUrl(req: Request): string {
  if (process.env.NEXT_PUBLIC_BASE_URL) {
    return process.env.NEXT_PUBLIC_BASE_URL;
  }
  
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
    return process.env.NODE_ENV === 'production' ? 'https://localhost' : 'http://localhost:3000';
  }
  
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${protocol}://${host}`;
}

export async function POST(req: Request) {
  console.log("[CHATBOT API] Received request")

  try {
    const body = await req.json()
    console.log("[CHATBOT API] Request body:", body)

    const { question } = body

    if (!question || typeof question !== "string") {
      console.log("[CHATBOT API] Invalid question format:", question)
      return NextResponse.json({ error: "Invalid question format" }, { status: 400 })
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error("[CHATBOT API] Missing OpenAI API key (OPENAI_API_KEY)")
      return new Response(
        "Error: API configuration issue. Please contact the site administrator.",
        { status: 500 },
      )
    }
    
    const baseUrl = getSafeBaseUrl(req);
    
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
    
    const basePrompt = await getChatbotPrompt();
    if (!basePrompt) {
      console.error("[CHATBOT API] Failed to load chatbot prompt");
      return new Response(
        "Error: Configuration issue. Please contact the site administrator.",
        { status: 500 },
      );
    }
    
    const enhancedPrompt = basePrompt + careerContext + projectContext;

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    })

    console.log("[CHATBOT API] Making OpenAI streaming call")

    try {
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

      console.log("[CHATBOT API] Streaming response from OpenAI")

      // Convert OpenAI stream to plain text stream (compatible with response.text())
      const encoder = new TextEncoder()
      const readable = new ReadableStream({
        async start(controller) {
          try {
            for await (const chunk of stream) {
              const content = chunk.choices[0]?.delta?.content || ''
              if (content) {
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

      return new Response(
        `segov@terminal:~$ echo "Error: API service unavailable"
Error: API service unavailable. Please try again later.`,
        { status: 503 },
      )
    }
  } catch (error) {
    console.error("[CHATBOT API] General error:", error)

    return new Response(
      `segov@terminal:~$ echo "Error: Something went wrong"
Error: Something went wrong. Please try again later.`,
      { status: 500 },
    )
  }
}
