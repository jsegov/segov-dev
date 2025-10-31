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
# Using pip
pip install -r requirements.txt

# Or using Poetry
poetry install
```

### Environment Variables

Create a `.env` file in the `backend/` directory with the following variables:

```env
PROJECT_ID=your-gcp-project-id
LOCATION=us-central1
RAG_CORPUS_NAME=projects/YOUR_PROJECT_ID/locations/us-central1/ragCorpora/YOUR_CORPUS_ID
PORT=8080
```

### Authentication

The service uses Google Application Default Credentials (ADC). Ensure you have:

1. Set up `gcloud` CLI and authenticated:
   ```bash
   gcloud auth application-default login
   ```

2. Or set the `GOOGLE_APPLICATION_CREDENTIALS` environment variable to point to your service account key file.

## Development

Run the development server:

```bash
# Using uvicorn directly
uvicorn app.main:app --reload --host 0.0.0.0 --port 8080

# Or using Python
python -m app.main
```

## MCP Tools

### `vector_search`

Search for relevant documents using vector search.

**Parameters:**
- `query` (str): The search query string
- `top_k` (int, optional): Number of results to return (default: 5)
- `distance_threshold` (float, optional): Distance threshold for filtering results

**Returns:** Dictionary with matched documents including text, score, source_uri, and metadata

### `ingest_from_gcs`

Ingest documents from GCS into the RAG corpus.

**Parameters:**
- `paths` (list[str]): List of GCS URIs or prefixes
- `chunk_size` (int, optional): Size of text chunks (default: 512)
- `chunk_overlap` (int, optional): Overlap between chunks (default: 100)
- `max_embedding_requests_per_min` (int, optional): Rate limit (default: 900)

**Returns:** Dictionary with ingestion status

### `doc_get`

Retrieve a document by RAG file ID or GCS URI.

**Parameters:**
- `rag_file_id` (str, optional): The RAG file ID
- `gcs_uri` (str, optional): The GCS URI of the document

**Returns:** Dictionary containing document content and metadata

## Deployment

See `../infra/` for Cloud Run deployment configurations.

## Notes

- The MCP server uses FastMCP's Streamable HTTP transport for remote access
- Ensure your Vertex AI RAG corpus is properly configured with a Vector Search index
- The service requires appropriate IAM roles: `roles/aiplatform.user`, `roles/storage.objectViewer`

