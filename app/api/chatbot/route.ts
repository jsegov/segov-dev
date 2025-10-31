import { NextResponse } from "next/server"
import OpenAI from "openai"
import { GoogleAuth } from "google-auth-library"
import { CareerEntry, ProjectEntry, getChatbotPrompt } from "@/lib/content"

// Get Google OAuth access token for Vertex AI authentication
async function getGoogleAccessToken(): Promise<string> {
  const credentialsJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON

  if (!credentialsJson) {
    throw new Error('GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable is not set')
  }

  let credentials
  try {
    credentials = JSON.parse(credentialsJson)
  } catch (error) {
    throw new Error('Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON: Invalid JSON')
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  })

  const client = await auth.getClient()
  const accessToken = await client.getAccessToken()

  if (!accessToken.token) {
    throw new Error('Failed to obtain access token')
  }

  return accessToken.token
}

// Construct Vertex AI endpoint URL from environment variables
function getVertexAIEndpointUrl(): string {
  const projectId = process.env.VERTEX_AI_PROJECT_ID
  const location = process.env.VERTEX_AI_LOCATION || 'us-central1'
  const endpointId = process.env.VERTEX_AI_ENDPOINT_ID

  if (!projectId || !endpointId) {
    throw new Error('VERTEX_AI_PROJECT_ID and VERTEX_AI_ENDPOINT_ID must be set')
  }

  return `https://${location}-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/${location}/endpoints/${endpointId}`
}

// Determine which model to use
const MODEL_ID = process.env.LLM_MODEL_ID || process.env.VERTEX_AI_SERVED_NAME || 'qwen3-8b-vllm'

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

    // Validate Vertex AI configuration
    if (!process.env.VERTEX_AI_PROJECT_ID || !process.env.VERTEX_AI_ENDPOINT_ID) {
      console.error("[CHATBOT API] Missing Vertex AI configuration (VERTEX_AI_PROJECT_ID or VERTEX_AI_ENDPOINT_ID)")
      return new Response(
        "Error: API configuration issue. Please contact the site administrator.",
        { status: 500 },
      )
    }

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      console.error("[CHATBOT API] Missing GOOGLE_APPLICATION_CREDENTIALS_JSON")
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
    
    // Fetch base system prompt from JSON file
    const basePrompt = await getChatbotPrompt();
    if (!basePrompt) {
      console.error("[CHATBOT API] Failed to load chatbot prompt");
      return new Response(
        "Error: Configuration issue. Please contact the site administrator.",
        { status: 500 },
      );
    }
    
    // Enhance system prompt with career and project data
    const enhancedPrompt = basePrompt + careerContext + projectContext;

    console.log("[CHATBOT API] Fetching Google OAuth token for Vertex AI")
    
    // Get Google access token for Vertex AI authentication
    let accessToken: string
    try {
      accessToken = await getGoogleAccessToken()
    } catch (tokenError) {
      console.error("[CHATBOT API] Failed to get access token:", tokenError)
      return new Response(
        "Error: Authentication failed. Please contact the site administrator.",
        { status: 500 },
      )
    }

    // Construct Vertex AI endpoint URL
    const vertexEndpointUrl = getVertexAIEndpointUrl()
    console.log("[CHATBOT API] Using Vertex AI endpoint:", vertexEndpointUrl)

    // Initialize OpenAI client with Vertex AI endpoint and Google token
    // Note: OpenAI SDK automatically appends /v1 to baseURL, so baseURL should NOT include /v1
    const openai = new OpenAI({
      apiKey: accessToken,
      baseURL: vertexEndpointUrl,
    })

    console.log("[CHATBOT API] Making OpenAI streaming call to Vertex AI")

    try {
      // Use OpenAI SDK streaming chat completions (compatible with Vertex AI)
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

      console.log("[CHATBOT API] Streaming response from Vertex AI")

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
      console.error("[CHATBOT API] Vertex AI API error:", aiError)

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
