"""FastAPI application with MCP server integration."""
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from mcp.server.fastmcp import FastMCP
from app.config import settings
from app.deps import init_vertex_ai
from app.mcp_tools import vector_search, ingest_from_gcs, doc_get

# Initialize Vertex AI
init_vertex_ai(settings.project_id, settings.location)

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
    paths: list[str],
    chunk_size: int = 512,
    chunk_overlap: int = 100,
    max_embedding_requests_per_min: int = 900,
) -> dict:
    """
    Ingest documents from GCS into the RAG corpus.

    Args:
        paths: List of GCS URIs or prefixes (e.g., ['gs://bucket/path'])
        chunk_size: Size of text chunks (default: 512)
        chunk_overlap: Overlap between chunks (default: 100)
        max_embedding_requests_per_min: Rate limit for embeddings (default: 900)
    """
    return await ingest_from_gcs(paths, chunk_size, chunk_overlap, max_embedding_requests_per_min)


@mcp.tool()
async def doc_get_tool(
    rag_file_id: str | None = None,
    gcs_uri: str | None = None,
) -> dict:
    """
    Retrieve a document by RAG file ID or GCS URI.

    Args:
        rag_file_id: The RAG file ID
        gcs_uri: The GCS URI of the document
    """
    return await doc_get(rag_file_id, gcs_uri)


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

