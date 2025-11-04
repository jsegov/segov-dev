"""Pydantic schemas for chat API requests and responses."""
from typing import Optional
from pydantic import BaseModel


class ChatRequest(BaseModel):
    """Request schema for chat endpoint."""
    session_id: str
    input: str
    stream: bool = False
    model: Optional[str] = None
    temperature: Optional[float] = None
    system: Optional[str] = None


class ChatResponse(BaseModel):
    """Response schema for non-streaming chat endpoint."""
    text: str


class ChatChunk(BaseModel):
    """SSE event chunk schema."""
    event: str  # token | done | error
    data: str

