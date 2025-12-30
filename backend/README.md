# MCP Backend - Vertex AI RAG Server

FastAPI-based MCP server for Vertex AI RAG Engine operations.

## Overview

This backend service exposes Model Context Protocol (MCP) tools for:
- Vector search against a Vertex AI RAG corpus
- Ingesting documents from GCS into the corpus
- Retrieving document content by ID or GCS URI

## Setup

### Prerequisites

- Python 3.11+
- Google Cloud Project with Vertex AI enabled
- Vertex AI RAG corpus already created and configured

### Installation

```bash
# Using pip (recommended to use uv for FastMCP 2.0)
pip install -r requirements.txt

# Or using uv (recommended for FastMCP 2.0)
uv pip install -r requirements.txt

# Or using Poetry
poetry install
```

**Note:** This project uses FastMCP 2.0, which is a standalone package. The old `mcp[cli]` package is no longer used.

### Creating a RAG Corpus

Before running the backend, you need to create a Vertex AI RAG corpus. You can do this in two ways:

#### Option 1: Using the provided script (recommended)

```bash
python scripts/create_corpus.py \
  --project-id YOUR_PROJECT_ID \
  --location us-central1 \
  --display-name my-corpus
```

This will create the corpus and output the `RAG_CORPUS_NAME` value you need.

#### Option 2: Using Python directly

```python
from vertexai import rag
import vertexai

vertexai.init(project="YOUR_PROJECT_ID", location="us-central1")

embedding_model_config = rag.RagEmbeddingModelConfig(
    vertex_prediction_endpoint=rag.VertexPredictionEndpoint(
        publisher_model="publishers/google/models/text-embedding-005"
    )
)

rag_corpus = rag.create_corpus(
    display_name="my-corpus",
    backend_config=rag.RagVectorDbConfig(
        rag_embedding_model_config=embedding_model_config
    ),
)

print(f"RAG_CORPUS_NAME={rag_corpus.name}")
```

The `rag_corpus.name` property contains the full resource name in the format:
```
projects/YOUR_PROJECT_ID/locations/us-central1/ragCorpora/CORPUS_ID
```

#### Listing existing corpora

To see existing corpora:

```bash
python scripts/create_corpus.py --project-id YOUR_PROJECT_ID --list
```

### Environment Variables

Create a `.env` file in the `backend/` directory with the following variables:

```env
PROJECT_ID=your-gcp-project-id
LOCATION=us-east1
RAG_CORPUS_NAME=projects/your-project-id/locations/us-east1/ragCorpora/your-corpus-id
GCS_BUCKET_NAME=segov-dev-bucket
PORT=8080
```

**Where to get RAG_CORPUS_NAME:**
- After creating a corpus using the script above, it will be printed to the console
- Or use the `rag_corpus.name` property from the corpus object
- Format: `projects/PROJECT_ID/locations/LOCATION/ragCorpora/CORPUS_ID`

### Authentication

#### Google Cloud Authentication

The service uses Google Application Default Credentials (ADC) for GCP operations. Ensure you have:

1. Set up `gcloud` CLI and authenticated:
   ```bash
   gcloud auth application-default login
   ```

2. Or set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to point to your service account key file.

#### MCP Server Authentication (FastMCP 2.0)

The MCP server supports optional authentication using FastMCP 2.0's auth provider system. By default, authentication is **disabled** for local testing.

**For Local Testing (No Authentication):**

By default, `MCP_REQUIRE_AUTH=false` (or unset), which disables authentication. This allows you to test locally without authentication:

```python
from fastmcp import Client

async with Client("http://localhost:8080/mcp") as client:
    tools = await client.list_tools()
```

**Enabling Authentication:**

To enable authentication, set `MCP_REQUIRE_AUTH=true` in your `.env` file:

```env
MCP_REQUIRE_AUTH=true
MCP_TOKEN_ISSUER=http://localhost:8080
MCP_TOKEN_AUDIENCE=vertex-rag-mcp
```

**Note:** Authentication is currently not fully implemented for FastMCP 2.0. The server will run without authentication even when `MCP_REQUIRE_AUTH=true`. For production, implement a proper FastMCP 2.0 auth provider (e.g., API key provider, OAuth provider). See [FastMCP 2.0 documentation](https://gofastmcp.com/) for auth provider implementation details.

When authentication is implemented, clients would connect as follows:

```python
from fastmcp import Client

# For OAuth authentication (example)
async with Client("http://localhost:8080/mcp", auth="oauth") as client:
    tools = await client.list_tools()
    
# For API key authentication (example - when implemented)
async with Client("http://localhost:8080/mcp", auth="api_key your-key") as client:
    tools = await client.list_tools()
```

## Development

Run the development server:

```bash
# Using uvicorn directly
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080

# Or using Python
python -m app.main
```

## Chat API (LangChain + MCP Integration)

The backend also provides chat endpoints that integrate with the MCP server, allowing the LLM to use MCP tools (vector search, document retrieval) when answering questions.

### Chat Endpoints

- `POST /v1/chat` - Non-streaming chat endpoint

**Request Schema:**
- `session_id` (required): Session identifier for maintaining conversation history
- `input` (required): User's message/query
- `model` (optional): Model ID override
- `temperature` (optional): Temperature override for model generation

**Note:** The `system` field is not accepted. The system prompt is managed server-side in `app/prompts/system_prompt.md`.

### MCP Integration in Chat

When `USE_MCP_IN_CHAT=true` (default), the chat endpoints use a LangChain agent that has access to MCP tools. The agent can automatically:
- Search for relevant documents using `vector_search`
- Retrieve document content using `doc_get`

If MCP connection fails or is disabled, the endpoints gracefully fall back to a basic LLM chain without tools.

### Chat Configuration

Add these environment variables to your `.env` file:

```env
# Required: OpenAI API key for chat model access
OPENAI_API_KEY=your-openai-api-key-here

# Optional: Model ID override (default: gpt-4o-mini)
CHAT_MODEL_ID=gpt-4o-mini

# MCP Integration Configuration
# URL of the MCP server endpoint (default: http://localhost:8080/mcp)
MCP_SERVER_URL=http://localhost:8080/mcp

# MCP transport type (default: streamable_http)
MCP_TRANSPORT=streamable_http

# Enable MCP tools in chat endpoints (default: true)
USE_MCP_IN_CHAT=true
```

### System Prompt

The system prompt is managed in the backend and is not client-overridable. It is loaded from `app/prompts/system_prompt.md` at startup. The prompt includes instructions for the assistant to:

- Answer questions about Jonathan Segovia (the site owner)
- Use MCP tools (when available) to retrieve work history and project information
- **If MCP tools are unavailable or resume.md cannot be retrieved for work history or project questions, do not make anything up. Instead, direct the user to the Career or Projects tabs on the website for accurate information.**

This ensures consistent behavior and prevents the model from fabricating information when data cannot be retrieved.

### Example Chat Request

```bash
curl -X POST http://localhost:8080/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "session_id": "user-123",
    "input": "What documents mention machine learning?"
  }'
```

**Note:** The `system` field is not accepted in the request. The system prompt is managed server-side.

The agent will automatically use `vector_search` to find relevant documents when needed.

### More Information

For LangChain MCP integration documentation, see: https://docs.langchain.com/oss/python/langchain/mcp

## MCP Tools

### `vector_search`

Search for relevant documents using vector search.

**Parameters:**
- `query` (str): The search query string
- `top_k` (int, optional): Number of results to return (default: 5)
- `distance_threshold` (float, optional): Distance threshold for filtering results

**Returns:** Dictionary with matched documents including text, score, source_uri, and metadata

### `ingest_from_gcs`

Ingest documents from GCS into the RAG corpus. Supports full GCS URIs or relative paths using the default bucket (`segov-dev-bucket`).

**Parameters:**
- `paths` (list[str], optional): List of GCS URIs or prefixes (e.g., `['gs://bucket/path']`)
- `prefix` (str, optional): GCS prefix to ingest all matching files (e.g., `'documents/'`). Uses default bucket if not a full URI.
- `chunk_size` (int, optional): Size of text chunks (default: 512)
- `chunk_overlap` (int, optional): Overlap between chunks (default: 100)
- `max_embedding_requests_per_min` (int, optional): Rate limit (default: 900)
- `bucket` (str, optional): Bucket name for prefix-based ingestion (defaults to `segov-dev-bucket`)

**Examples:**
```python
# Ingest all files from default bucket
ingest_from_gcs(prefix="documents/")

# Ingest specific files using full URIs
ingest_from_gcs(paths=["gs://segov-dev-bucket/doc1.md", "gs://segov-dev-bucket/doc2.md"])

# Ingest all files from a prefix in a different bucket
ingest_from_gcs(prefix="gs://other-bucket/docs/")
```

**Returns:** Dictionary with ingestion status including paths ingested

### `doc_get`

Retrieve a document by RAG file ID, GCS URI, or relative path.

**Security:** 
- When using the `path` parameter, only whitelisted files are allowed (currently only `resume.md`)
- Path traversal attacks are prevented (e.g., `../` is blocked)
- GCS URIs must use the configured bucket and cannot contain path traversal
- Internal backend files (like system prompts) are never exposed

**Parameters:**
- `rag_file_id` (str, optional): The RAG file ID (managed by Vertex AI RAG Engine)
- `gcs_uri` (str, optional): The full GCS URI of the document (e.g., `'gs://bucket/path/to/file.md'`)
  - Must use the configured `GCS_BUCKET_NAME`
  - Path traversal is blocked
- `path` (str, optional): Relative path within the default bucket (e.g., `'resume.md'`)
  - **Must be in the whitelist** (currently only `resume.md` is allowed)
  - Path traversal and absolute paths are blocked
- `bucket` (str, optional): **Ignored** - always uses the configured bucket for security

**Examples:**
```python
# Retrieve using whitelisted path (only resume.md is allowed)
doc_get(path="resume.md")

# Retrieve using full GCS URI (must use configured bucket)
doc_get(gcs_uri="gs://segov-dev-bucket/resume.md")
```

**Returns:** Dictionary containing document content and metadata (size, content_type, updated timestamp), or error message if path is not whitelisted or validation fails

## Testing

### Testing with pytest

When testing the MCP server locally, ensure authentication is disabled (default):

**Example test without authentication (default):**

```python
import pytest
from fastmcp import Client

@pytest.mark.asyncio
async def test_mcp_server():
    # Server must be running with MCP_REQUIRE_AUTH=false (default)
    async with Client("http://localhost:8080/mcp") as client:
        await client.ping()
        tools = await client.list_tools()
        assert len(tools) > 0
```

**Note:** Authentication is currently not fully implemented for FastMCP 2.0. Once authentication is implemented with a proper auth provider, tests with authentication would use the appropriate `auth` parameter based on the provider type (OAuth, API key, etc.). See [FastMCP 2.0 documentation](https://gofastmcp.com/) for client authentication examples.

## Deployment

See `../infra/` for Cloud Run deployment configurations.

## Notes

- The MCP server uses FastMCP 2.0's HTTP/SSE transport for remote access
- This project has been migrated from FastMCP 1.0 (in the `mcp` package) to FastMCP 2.0 (standalone `fastmcp` package)
- Ensure your Vertex AI RAG corpus is properly configured with a Vector Search index
- The service requires appropriate IAM roles: `roles/aiplatform.user`, `roles/storage.objectViewer`
- Default bucket (`segov-dev-bucket`) is configured in `env.example`. You can override it via `GCS_BUCKET_NAME` environment variable
- The bucket should be in the same region (`us-east1`) as your RAG corpus for optimal performance
- For FastMCP 2.0 documentation and features, see: https://gofastmcp.com/
