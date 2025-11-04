"""Chat message history management with in-memory storage."""
from typing import Dict
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.runnables.history import RunnableWithMessageHistory
from langchain_community.chat_message_histories import ChatMessageHistory
from app.chains import base_chain


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


# Wrap base chain with message history
with_history = RunnableWithMessageHistory(
    base_chain,
    get_session_history=get_session_history,
    input_messages_key="input",
    history_messages_key="history",
)

