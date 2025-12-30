"""Chat API routes with streaming support."""
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
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


class StreamingThinkFilter:
    """Streaming filter to remove <think>...</think> blocks from token stream.
    
    Buffers tokens while inside thinking blocks and yields only non-thinking content.
    Strips leading whitespace after closing </think> tags to match strip_thinking_tags().
    """
    
    def __init__(self):
        self.buffer = ""
        self.in_thinking = False
        self.strip_leading_ws = False  # Strip whitespace after exiting thinking block
    
    def process(self, token: str) -> str:
        """Process a token and return the portion that should be yielded to user.
        
        Args:
            token: The next token from the model
            
        Returns:
            Content that should be sent to the user (empty if inside thinking block)
        """
        self.buffer += token
        
        # If we just exited a thinking block, strip leading whitespace
        if self.strip_leading_ws:
            self.buffer = self.buffer.lstrip()
            if self.buffer:
                # Found non-whitespace, stop stripping
                self.strip_leading_ws = False
            else:
                # All whitespace, continue stripping on next token
                return ""
        
        # If we're in a thinking block, check for closing tag
        if self.in_thinking:
            if "</think>" in self.buffer:
                # Found end of thinking block
                end_idx = self.buffer.find("</think>") + len("</think>")
                # Discard thinking content, keep anything after (stripped)
                remaining = self.buffer[end_idx:].lstrip()
                self.buffer = ""
                self.in_thinking = False
                if remaining:
                    # Check for another thinking block in remaining
                    self.buffer = remaining
                    return self._process_non_thinking()
                else:
                    # No content after tag yet, strip whitespace on next tokens
                    self.strip_leading_ws = True
                    return ""
            return ""  # Still inside thinking block, yield nothing
        
        return self._process_non_thinking()
    
    def _process_non_thinking(self) -> str:
        """Process buffer when not inside a thinking block."""
        # Check for start of thinking block
        if "<think>" in self.buffer:
            start_idx = self.buffer.find("<think>")
            # Yield everything before the thinking block
            to_yield = self.buffer[:start_idx]
            self.buffer = self.buffer[start_idx:]
            self.in_thinking = True
            
            # Check if thinking block also closes in this token
            if "</think>" in self.buffer:
                end_idx = self.buffer.find("</think>") + len("</think>")
                remaining = self.buffer[end_idx:].lstrip()
                self.buffer = ""
                self.in_thinking = False
                if remaining:
                    # Check for another thinking block in remaining
                    self.buffer = remaining
                    return to_yield + self._process_non_thinking()
                else:
                    # No content after tag yet, strip whitespace on next tokens
                    self.strip_leading_ws = True
                    return to_yield
            return to_yield
        
        # Check for partial tag at end that might be start of <think>
        for i in range(1, min(len("<think>"), len(self.buffer) + 1)):
            if self.buffer.endswith("<think>"[:i]):
                # Potential partial tag, hold it back
                to_yield = self.buffer[:-i]
                self.buffer = self.buffer[-i:]
                return to_yield
        
        # No thinking tags, yield everything
        to_yield = self.buffer
        self.buffer = ""
        return to_yield
    
    def flush(self) -> str:
        """Flush any remaining buffered content.
        
        Call this after all tokens have been processed.
        Returns any non-thinking content that was buffered.
        """
        if self.in_thinking:
            # Unclosed thinking block, discard it
            self.buffer = ""
            self.in_thinking = False
            self.strip_leading_ws = False
            return ""
        result = self.buffer
        self.buffer = ""
        self.strip_leading_ws = False
        return result

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
                                    text = msg.content
                                    break
                    
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


@router.post("/chat/stream")
async def chat_stream(req: ChatRequest):
    """Streaming chat endpoint using SSE.
    
    Args:
        req: Chat request with session_id, input, and optional overrides
    
    Returns:
        SSE stream with token, done, or error events
    """
    async def gen():
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
                        
                        emitted = False
                        full_response_content = ""
                        think_filter = StreamingThinkFilter()
                        
                        async for event in agent.astream_events(
                            {"messages": messages},
                            config={"configurable": {"session_id": req.session_id}},
                            version="v2",
                        ):
                            if event.get("event") == "on_chat_model_stream":
                                if "chunk" in event.get("data", {}):
                                    chunk = event["data"]["chunk"]
                                    if hasattr(chunk, "content") and chunk.content:
                                        # Filter out thinking blocks before yielding
                                        filtered = think_filter.process(chunk.content)
                                        if filtered:
                                            yield {"event": "token", "data": filtered}
                                            emitted = True
                                        full_response_content += chunk.content
                            elif event.get("event") == "on_chain_end" and event.get("name") == "AgentExecutor":
                                if "output" in event.get("data", {}):
                                    output = event["data"]["output"]
                                    if isinstance(output, str) and output:
                                        filtered = think_filter.process(output)
                                        if filtered:
                                            yield {"event": "token", "data": filtered}
                                            emitted = True
                                        full_response_content += output
                                    elif isinstance(output, dict) and "output" in output:
                                        filtered = think_filter.process(output["output"])
                                        if filtered:
                                            yield {"event": "token", "data": filtered}
                                            emitted = True
                                        full_response_content += output["output"]
                        
                        # Flush any remaining content from the filter
                        remaining = think_filter.flush()
                        if remaining:
                            yield {"event": "token", "data": remaining}
                            emitted = True
                            full_response_content += remaining
                        
                        # Strip thinking tags from full content before saving to history
                        clean_response = strip_thinking_tags(full_response_content)
                        
                        # Validate AFTER stripping - response might be only thinking blocks
                        if not emitted or not clean_response.strip():
                            raise ValueError("Agent produced no tokens or empty response after stripping thinking blocks")
                        
                        # Add messages to history only after confirming valid response
                        # Add both atomically to prevent inconsistency
                        history.add_user_message(req.input)
                        history.add_ai_message(clean_response)
                    
                    yield {"event": "done", "data": req.session_id}
                    return
                except Exception as mcp_error:
                    logger.warning(f"MCP agent streaming failed, falling back to chain: {mcp_error}", exc_info=True)
                    # Fall through to non-MCP chain
            
            # Fallback to non-MCP chain
            # Use base chain (not history-wrapped) so we can manually save cleaned history
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
            think_filter = StreamingThinkFilter()
            emitted = False
            full_response_content = ""
            
            async for chunk in chain.astream(input_data):
                full_response_content += chunk
                # Filter out thinking blocks before yielding
                filtered = think_filter.process(chunk)
                if filtered:
                    yield {"event": "token", "data": filtered}
                    emitted = True
            
            # Flush any remaining content from the filter
            remaining = think_filter.flush()
            if remaining:
                yield {"event": "token", "data": remaining}
                emitted = True
                full_response_content += remaining
            
            # Strip thinking tags and validate
            clean_response = strip_thinking_tags(full_response_content)
            
            if not emitted or not clean_response.strip():
                raise ValueError("Chain produced no tokens after stripping thinking blocks")
            
            # Save cleaned response to history
            history.add_user_message(req.input)
            history.add_ai_message(clean_response)
            
            yield {"event": "done", "data": req.session_id}
        except Exception as e:
            logger.error(f"Stream error: {e}", exc_info=True)
            yield {"event": "error", "data": str(e)}
            yield {"event": "done", "data": req.session_id}
    
    return EventSourceResponse(gen())

