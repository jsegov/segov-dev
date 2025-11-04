"""MCP client for LangChain integration."""
from langchain_mcp_adapters.client import MultiServerMCPClient
from app.config import settings


def build_mcp_client() -> MultiServerMCPClient:
    """Create and return MCP client configured from settings."""
    servers = {
        'vertex-rag': {
            'transport': settings.mcp_transport,
            'url': settings.mcp_server_url,
        }
    }
    return MultiServerMCPClient(servers)

