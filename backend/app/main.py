"""FastAPI application with MCP server integration and LangChain chat."""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastmcp import FastMCP
from app.config import settings
from app.deps import init_vertex_ai
from app.mcp_tools import vector_search, doc_get
from app.routes_chat import router as chat_router
import logging

logger = logging.getLogger(__name__)

if settings.project_id != 'your-gcp-project-id':
    init_vertex_ai(settings.project_id, settings.location)


def create_auth_provider():
    """Create an auth provider based on configuration.
    
    Returns:
        Auth provider instance if auth is enabled, None otherwise
    """
    if not settings.mcp_require_auth:
        logger.info('MCP authentication disabled (MCP_REQUIRE_AUTH=false)')
        return None
    
    logger.info('MCP authentication enabled (MCP_REQUIRE_AUTH=true)')
    logger.warning(
        'Authentication enabled but not yet fully implemented for FastMCP 2.0. '
        'Server will run without authentication. For production, implement '
        'proper auth provider (API key, OAuth, etc.)'
    )
    return None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Lifespan context manager for FastAPI app."""
    # Startup
    logger.info('Starting FastAPI application with MCP and chat endpoints')
    yield
    # Shutdown
    logger.info('Shutting down FastAPI application')


# Create MCP server
auth_provider = create_auth_provider()
mcp = FastMCP('vertex-rag-mcp', auth=auth_provider)

@mcp.tool()
async def vector_search_tool(
    query: str,
    top_k: int = 5,
    distance_threshold: float | None = None,
) -> dict:
    """
    Search for relevant documents using vector search.

    Args:
        query: The search query string
        top_k: Number of results to return (default: 5)
        distance_threshold: Optional distance threshold for filtering results
    """
    return await vector_search(query, top_k, distance_threshold)


@mcp.tool()
async def doc_get_tool(
    rag_file_id: str | None = None,
    gcs_uri: str | None = None,
    path: str | None = None,
    bucket: str | None = None,
) -> dict:
    """
    Retrieve a document by RAG file ID, GCS URI, or path.

    Args:
        rag_file_id: The RAG file ID
        gcs_uri: The full GCS URI of the document (e.g., 'gs://bucket/path/to/file.md')
        path: Relative path within the default bucket (e.g., 'documents/file.md')
        bucket: Bucket name to use if path is provided (defaults to segov-dev-bucket)
    """
    return await doc_get(rag_file_id, gcs_uri, path, bucket)


# Get MCP HTTP app and its lifespan
# Pass path="/" so routes are registered at root within the mounted app
mcp_http_app = mcp.http_app(path="/")


@asynccontextmanager
async def combined_lifespan(app: FastAPI):
    """Combined lifespan that includes both FastAPI and MCP lifespans."""
    # Start MCP lifespan first (this initializes the task group)
    async with mcp_http_app.lifespan(app):
        # Then start our FastAPI lifespan
        async with lifespan(app):
            yield


# Create FastAPI root app with combined lifespan
app = FastAPI(
    title="Chat API",
    version="1.0.0",
    lifespan=combined_lifespan,
)

# Add CORS middleware for localhost:3000 (dev)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include chat router
app.include_router(chat_router)

# Mount MCP app at /mcp
app.mount("/mcp", mcp_http_app)

# Add request logging middleware
@app.middleware("http")
async def log_requests(request, call_next):
    """Log all requests for debugging."""
    method = request.method
    path = request.url.path
    logger.info(f"Request: {method} {path}")
    
    try:
        response = await call_next(request)
        logger.info(f"Response: {method} {path} -> {response.status_code}")
        return response
    except Exception as e:
        logger.error(f"Error handling {method} {path}: {e}", exc_info=True)
        raise

# Add health check endpoints
@app.get('/health')
async def health():
    """Health check endpoint."""
    return JSONResponse({'status': 'healthy'})

@app.get('/')
async def root():
    """Root endpoint."""
    return JSONResponse({'status': 'ok', 'service': 'vertex-rag-mcp'})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=settings.port)

