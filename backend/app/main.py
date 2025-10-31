"""FastAPI application with MCP server integration."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from app.config import settings
from app.deps import init_vertex_ai
from app.mcp_tools import vector_search, ingest_from_gcs, doc_get

# Initialize Vertex AI (only if valid project ID is set)
try:
    if settings.project_id and settings.project_id != 'your-gcp-project-id':
        init_vertex_ai(settings.project_id, settings.location)
    else:
        print('Warning: PROJECT_ID not set. Vertex AI features will not work.')
except Exception as e:
    print(f'Warning: Failed to initialize Vertex AI: {e}')

# Create FastMCP instance
mcp = FastMCP('vertex-rag-mcp')

# Register MCP tools
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


# Create FastAPI app
app = FastAPI(
    title='Vertex AI RAG MCP Server',
    description='MCP server for Vertex AI RAG Engine operations',
    version='0.1.0',
)


@app.get('/')
async def root():
    """Health check endpoint."""
    return {'status': 'ok', 'service': 'vertex-rag-mcp'}


@app.get('/health')
async def health():
    """Health check endpoint."""
    return {'status': 'healthy'}


# Mount MCP server
# Note: FastMCP integration with FastAPI may require additional setup
# depending on the FastMCP library version and remote transport requirements
# This is a basic structure that may need adjustment based on FastMCP docs

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='0.0.0.0', port=settings.port)

