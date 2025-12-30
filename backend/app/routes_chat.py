"""Chat API routes without streaming support."""
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from app.schemas import ChatRequest, ChatResponse
from app.memory import get_session_history
from app.chains import create_chain, SYSTEM_PROMPT
from app.config import settings
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
import logging

logger = logging.getLogger(__name__)

# Pattern to match <think>...</think> blocks (including multiline)
# Uses \s* to consume whitespace after closing tag (consistent with StreamingThinkFilter.lstrip())
_THINK_PATTERN = re.compile(r'<think>.*?</think>\s*', re.DOTALL)


def strip_thinking_tags(text: str) -> str:
    """Strip <think>...</think> reasoning blocks from model output.
    
    Qwen3 and similar models use these tags for chain-of-thought reasoning
    that should not be exposed to end users.
    
    Note: Does NOT strip leading/trailing whitespace from the full result to maintain
    consistency with StreamingThinkFilter which only strips whitespace after </think> tags.
    """
    return _THINK_PATTERN.sub('', text)


router = APIRouter(prefix="/v1")


@router.post("/chat", response_model=ChatResponse)
async def chat(req: ChatRequest):
    """Non-streaming chat endpoint.
    
    Args:
        req: Chat request with session_id, input, and optional overrides
    
    Returns:
        JSON response with text field
    """
    try:
        # Try MCP agent if enabled
        if settings.use_mcp_in_chat:
            try:
                from app.agent import build_agent_with_mcp
                async with build_agent_with_mcp(
                    req.model or settings.chat_model_id,
                    req.temperature if req.temperature is not None else 0.2
                ) as agent:
                    history = get_session_history(req.session_id)
                    messages = []
                    messages.append(SystemMessage(content=SYSTEM_PROMPT))
                    for msg in history.messages:
                        messages.append(msg)
                    messages.append(HumanMessage(content=req.input))
                    
                    out = await agent.ainvoke(
                        {"messages": messages},
                        config={"configurable": {"session_id": req.session_id}},
                    )
                    
                    # Extract text from response first to validate
                    text: str | None = None
                    if isinstance(out, str):
                        text = out
                    elif isinstance(out, dict):
                        text = out.get("output")
                        if not text and "messages" in out:
                            for msg in reversed(out["messages"]):
                                if isinstance(msg, AIMessage):
                                    # AIMessage.content can be str or List[Union[str, Dict]]
                                    # (list when containing tool calls). Only use string content.
                                    if isinstance(msg.content, str):
                                        text = msg.content
                                        break
                                    elif isinstance(msg.content, list):
                                        # Extract string parts from list content
                                        extracted = "".join(
                                            item if isinstance(item, str) else ""
                                            for item in msg.content
                                        )
                                        # Only use if we found actual text (not just tool calls)
                                        if extracted:
                                            text = extracted
                                            break
                                        # Otherwise continue searching earlier messages
                    
                    # Strip <think>...</think> reasoning blocks before validation
                    text = strip_thinking_tags(text) if text else text
                    
                    # Validate AFTER stripping - response might be only thinking blocks
                    if not text or not text.strip():
                        raise ValueError("Agent returned empty response")
                    
                    # Add messages to history only after confirming valid response
                    # Add both atomically to prevent inconsistency
                    history.add_user_message(req.input)
                    history.add_ai_message(text)
                    
                    return JSONResponse({"text": text})
            except Exception as mcp_error:
                logger.warning(f"MCP agent failed, falling back to chain: {mcp_error}", exc_info=True)
                # Fall through to non-MCP chain
        
        # Fallback to non-MCP chain
        # Use base chain (not history-wrapped) so we can manually save cleaned history
        # This prevents RunnableWithMessageHistory from auto-saving unstripped content
        chain = create_chain(
            model=req.model,
            temperature=req.temperature
        )
        
        history = get_session_history(req.session_id)
        input_data = {
            "input": req.input,
            "system": SYSTEM_PROMPT,
            "history": history.messages,
        }
        
        out = await chain.ainvoke(input_data)
        # Strip <think>...</think> reasoning blocks from fallback chain too
        out = strip_thinking_tags(out)
        
        # Validate AFTER stripping - response might be only thinking blocks
        if not out or not out.strip():
            raise ValueError("Chain returned empty response after stripping thinking blocks")
        
        # Save cleaned response to history (after stripping, not before)
        history.add_user_message(req.input)
        history.add_ai_message(out)
        
        return JSONResponse({"text": out})
    except Exception as e:
        logger.error(f"Chat error: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))
