"""Pydantic schemas for chat API requests and responses."""
from typing import Optional
from pydantic import BaseModel, ConfigDict


class ChatRequest(BaseModel):
    """Request schema for chat endpoint."""
    model_config = ConfigDict(extra='forbid')
    
    session_id: str
    input: str
    stream: bool = False
    model: Optional[str] = None
    temperature: Optional[float] = None


class ChatResponse(BaseModel):
    """Response schema for non-streaming chat endpoint."""
    text: str


class ChatChunk(BaseModel):
    """SSE event chunk schema."""
    event: str  # token | done | error
    data: str

