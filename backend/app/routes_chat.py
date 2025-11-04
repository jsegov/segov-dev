"""Chat API routes with streaming support."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse
from app.schemas import ChatRequest, ChatResponse
from app.memory import with_history, get_session_history
from app.chains import create_chain, SYSTEM_PROMPT
from app.config import settings
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_core.messages import HumanMessage, SystemMessage, AIMessage
import logging

logger = logging.getLogger(__name__)

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
                    
                    # Only add to history if we have a valid, non-empty response
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
        chain = with_history
        if req.model or req.temperature is not None:
            # Create new chain with overrides
            new_base = create_chain(model=req.model, temperature=req.temperature)
            chain = RunnableWithMessageHistory(
                new_base,
                get_session_history=get_session_history,
                input_messages_key="input",
                history_messages_key="history",
            )
        
        input_data = {"input": req.input, "system": SYSTEM_PROMPT}
        
        out = await chain.ainvoke(
            input_data,
            config={"configurable": {"session_id": req.session_id}},
        )
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
                        
                        async for event in agent.astream_events(
                            {"messages": messages},
                            config={"configurable": {"session_id": req.session_id}},
                            version="v2",
                        ):
                            if event.get("event") == "on_chat_model_stream":
                                if "chunk" in event.get("data", {}):
                                    chunk = event["data"]["chunk"]
                                    if hasattr(chunk, "content") and chunk.content:
                                        yield {"event": "token", "data": chunk.content}
                                        full_response_content += chunk.content
                                        emitted = True
                            elif event.get("event") == "on_chain_end" and event.get("name") == "AgentExecutor":
                                if "output" in event.get("data", {}):
                                    output = event["data"]["output"]
                                    if isinstance(output, str) and output:
                                        yield {"event": "token", "data": output}
                                        full_response_content += output
                                        emitted = True
                                    elif isinstance(output, dict) and "output" in output:
                                        yield {"event": "token", "data": output["output"]}
                                        full_response_content += output["output"]
                                        emitted = True
                        
                        # Only add to history if we have valid, non-empty response
                        if not emitted or not full_response_content.strip():
                            raise ValueError("Agent produced no tokens or empty response")
                        
                        # Add messages to history only after confirming valid response
                        # Add both atomically to prevent inconsistency
                        history.add_user_message(req.input)
                        history.add_ai_message(full_response_content)
                    
                    yield {"event": "done", "data": req.session_id}
                    return
                except Exception as mcp_error:
                    logger.warning(f"MCP agent streaming failed, falling back to chain: {mcp_error}", exc_info=True)
                    # Fall through to non-MCP chain
            
            # Fallback to non-MCP chain
            chain = with_history
            if req.model or req.temperature is not None:
                new_base = create_chain(model=req.model, temperature=req.temperature)
                chain = RunnableWithMessageHistory(
                    new_base,
                    get_session_history=get_session_history,
                    input_messages_key="input",
                    history_messages_key="history",
                )
            
            input_data = {"input": req.input, "system": SYSTEM_PROMPT}
            
            async for chunk in chain.astream(
                input_data,
                config={"configurable": {"session_id": req.session_id}},
            ):
                yield {"event": "token", "data": chunk}
            
            yield {"event": "done", "data": req.session_id}
        except Exception as e:
            logger.error(f"Stream error: {e}", exc_info=True)
            yield {"event": "error", "data": str(e)}
            yield {"event": "done", "data": req.session_id}
    
    return EventSourceResponse(gen())

