from fastapi import FastAPI
from pydantic import BaseModel
from openai import AsyncOpenAI
import os

app = FastAPI()

VLLM_API_URL = os.getenv("VLLM_API_URL", "http://localhost:8000/v1")
VLLM_API_KEY = os.getenv("VLLM_API_KEY", "EMPTY")
SHOW_REASONING = os.getenv("SHOW_REASONING", "True").lower() == "true"
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "Qwen/Qwen3-8B")

client = AsyncOpenAI(base_url=VLLM_API_URL, api_key=VLLM_API_KEY)

class ChatRequest(BaseModel):
    messages: list[dict]

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    response = await client.chat.completions.create(
        model=DEFAULT_MODEL,
        messages=request.messages,
        temperature=0.6,
        top_p=0.95,
        max_tokens=2048
    )
    
    message = response.choices[0].message
    reasoning = getattr(message, 'reasoning_content', None)
    final_content = message.content
    
    if SHOW_REASONING and reasoning:
        normalized_content = (
            f"<details>\n<summary>Thinking Process</summary>\n\n"
            f"{reasoning}\n\n"
            f"</details>\n\n"
            f"{final_content}"
        )
    else:
        normalized_content = final_content
        
    return {"role": "assistant", "content": normalized_content}

@app.get("/health")
async def health_check():
    return {"status": "ok"}
