"""FastAPI application with MCP server integration."""
from fastapi import FastAPI
from fastmcp import FastMCP
from app.config import settings
from app.deps import init_vertex_ai
from app.mcp_tools import vector_search, ingest_from_gcs, doc_get
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
async def ingest_from_gcs_tool(
    paths: list[str] | None = None,
    prefix: str | None = None,
    chunk_size: int = 512,
    chunk_overlap: int = 100,
    max_embedding_requests_per_min: int = 900,
    bucket: str | None = None,
) -> dict:
    """
    Ingest documents from GCS into the RAG corpus.

    Args:
        paths: List of GCS URIs or prefixes (e.g., ['gs://bucket/path'])
        prefix: GCS prefix to ingest all matching files (e.g., 'documents/'). Uses default bucket if not full URI.
        chunk_size: Size of text chunks (default: 512)
        chunk_overlap: Overlap between chunks (default: 100)
        max_embedding_requests_per_min: Rate limit for embeddings (default: 900)
        bucket: Bucket name for prefix-based ingestion (defaults to segov-dev-bucket)
    """
    return await ingest_from_gcs(
        paths=paths,
        prefix=prefix,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        max_embedding_requests_per_min=max_embedding_requests_per_min,
        bucket=bucket,
    )


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


# Use FastMCP's http_app as the base application
app = mcp.http_app()

# Add health check routes directly to the FastMCP app
@app.route('/health', methods=['GET'])
async def health(request):
    """Health check endpoint."""
    from starlette.responses import JSONResponse
    return JSONResponse({'status': 'healthy'})

@app.route('/', methods=['GET'])
async def root(request):
    """Root endpoint."""
    from starlette.responses import JSONResponse
    return JSONResponse({'status': 'ok', 'service': 'vertex-rag-mcp'})


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=settings.port)

