"""LangChain agent with MCP tools."""
from contextlib import asynccontextmanager

try:
    from langchain_openai import ChatOpenAI
    from langchain.agents import create_agent
    from langchain_mcp_adapters.tools import load_mcp_tools
    from app.mcp_client import build_mcp_client
    from app.config import settings
    _AGENT_IMPORTS_AVAILABLE = True
except ImportError as e:
    _AGENT_IMPORTS_AVAILABLE = False
    _AGENT_IMPORT_ERROR = e


@asynccontextmanager
async def build_agent_with_mcp(model: str | None = None, temperature: float | None = None):
    """Create a LangChain agent with MCP tools.
    
    This is an async context manager that yields the agent and keeps the
    MCP session alive for the duration of its use.
    
    Args:
        model: Model name override (defaults to settings.chat_model_id)
        temperature: Temperature override (defaults to 0.2)
    
    Yields:
        Agent executor that can use MCP tools
    
    Raises:
        ImportError: If required dependencies are not available
    """
    if not _AGENT_IMPORTS_AVAILABLE:
        raise ImportError(f"Agent imports not available: {_AGENT_IMPORT_ERROR}")
    
    model_name = model or settings.chat_model_id
    temp = temperature if temperature is not None else 0.2
    
    llm = ChatOpenAI(
        model=model_name,
        temperature=temp,
        streaming=True,
        api_key=settings.openai_api_key,
    )
    
    client = build_mcp_client()
    async with client.session('vertex-rag') as session:
        tools = await load_mcp_tools(session)
        agent = create_agent(llm, tools)
        yield agent

