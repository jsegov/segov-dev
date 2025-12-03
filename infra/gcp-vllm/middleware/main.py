from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from openai import AsyncOpenAI
from openai import APIError, APIConnectionError, APITimeoutError, RateLimitError
import os
import logging

logger = logging.getLogger(__name__)

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
    try:
        response = await client.chat.completions.create(
            model=DEFAULT_MODEL,
            messages=request.messages,
            temperature=0.6,
            top_p=0.95,
            max_tokens=2048
        )
    except APIConnectionError as e:
        logger.error(f"Failed to connect to vLLM service at {VLLM_API_URL}: {e}", exc_info=True)
        raise HTTPException(
            status_code=503,
            detail=f"vLLM service is unreachable: {str(e)}"
        )
    except APITimeoutError as e:
        logger.error(f"Request to vLLM service timed out: {e}", exc_info=True)
        raise HTTPException(
            status_code=504,
            detail=f"vLLM service request timed out: {str(e)}"
        )
    except RateLimitError as e:
        logger.warning(f"Rate limit exceeded for vLLM service: {e}", exc_info=True)
        raise HTTPException(
            status_code=429,
            detail=f"Rate limit exceeded: {str(e)}"
        )
    except APIError as e:
        logger.error(f"vLLM API error: {e}", exc_info=True)
        # Use status code from error if available, otherwise 502
        status_code = getattr(e, 'status_code', 502)
        raise HTTPException(
            status_code=status_code,
            detail=f"vLLM API error: {str(e)}"
        )
    except Exception as e:
        logger.error(f"Unexpected error calling vLLM service: {e}", exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Internal error: {str(e)}"
        )
    
    if not response.choices:
        raise HTTPException(
            status_code=502,
            detail='vLLM returned empty choices list'
        )
    
    message = response.choices[0].message
    reasoning = getattr(message, 'reasoning_content', None)
    final_content = message.content or ""
    
    if SHOW_REASONING and reasoning:
        normalized_content = (
            f"<details>\n<summary>Thinking Process</summary>\n\n"
            f"{reasoning}\n\n"
            f"</details>\n\n"
            f"{final_content}"
        )
    else:
        # If content is None but reasoning exists, use reasoning as fallback
        normalized_content = final_content if final_content else (reasoning or "")
        
    return {"role": "assistant", "content": normalized_content}

@app.get("/health")
async def health_check():
    return {"status": "ok"}
