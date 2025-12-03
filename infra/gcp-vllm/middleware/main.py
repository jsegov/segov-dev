from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from openai import AsyncOpenAI
import os

app = FastAPI()

# Configuration
# In production, these should be set via environment variables
VLLM_API_URL = os.getenv("VLLM_API_URL", "http://localhost:8000/v1")
VLLM_API_KEY = os.getenv("VLLM_API_KEY", "EMPTY") # vLLM default
SHOW_REASONING = os.getenv("SHOW_REASONING", "True").lower() == "true"
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "Qwen/Qwen3-8B")

client = AsyncOpenAI(base_url=VLLM_API_URL, api_key=VLLM_API_KEY)

class ChatRequest(BaseModel):
    messages: list
    # The frontend doesn't get to choose the model or other params directly
    # This ensures strict decoupling

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        # 1. Agnostic -> Specific Transformation
        # We inject the specific model ID and sampling params optimized for Qwen3
        # or whatever the underlying model is.
        
        # Determine params based on model (simple logic for now)
        temperature = 0.6
        if "Qwen3" in DEFAULT_MODEL:
             temperature = 0.6 # Recommended for Qwen3 Thinking
        
        response = await client.chat.completions.create(
            model=DEFAULT_MODEL,
            messages=request.messages,
            temperature=temperature,
            top_p=0.95,
            max_tokens=2048
        )
        
        # 2. Specific -> Agnostic Normalization
        message = response.choices[0].message
        
        # Check if reasoning exists (Qwen3 feature)
        reasoning = getattr(message, 'reasoning_content', None)
        final_content = message.content
        
        if SHOW_REASONING and reasoning:
            # We format the output so the frontend just sees Markdown.
            # The frontend doesn't need to know this is "reasoning".
            # It just renders a collapsible section.
            normalized_content = (
                f"<details>\n<summary>Thinking Process</summary>\n\n"
                f"{reasoning}\n\n"
                f"</details>\n\n"
                f"{final_content}"
            )
        else:
            # If standard model or reasoning hidden, just return content
            normalized_content = final_content
            
        return {"role": "assistant", "content": normalized_content}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/health")
async def health_check():
    return {"status": "ok"}
