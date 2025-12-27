"""Chat message history management with in-memory storage."""
from typing import Dict
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.chat_message_histories import ChatMessageHistory
from app.chains import create_chain


# In-memory session cache (dev only; for prod, use Redis)
_session_cache: Dict[str, BaseChatMessageHistory] = {}


def get_session_history(session_id: str) -> BaseChatMessageHistory:
    """Get or create chat message history for a session.
    
    Args:
        session_id: Unique session identifier
    
    Returns:
        Chat message history instance
    """
    # Reuse histories to cut round-trips; safe for single-process dev
    hist = _session_cache.get(session_id)
    if not hist:
        hist = ChatMessageHistory()
        _session_cache[session_id] = hist
    return hist


def create_chain_with_history(
    model: str | None = None,
    temperature: float | None = None
) -> RunnableWithMessageHistory:
    """Create a chain wrapped with message history.
    
    Creates a fresh chain on each call to ensure auth tokens are refreshed.
    This prevents token expiration issues with long-running services.
    
    Args:
        model: Model name override
        temperature: Temperature override
    
    Returns:
        RunnableWithMessageHistory wrapping a fresh chain
    """
    chain = create_chain(model=model, temperature=temperature)
    return RunnableWithMessageHistory(
        chain,
        get_session_history=get_session_history,
        input_messages_key="input",
        history_messages_key="history",
    )

