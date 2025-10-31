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

**Parameters:**
- `rag_file_id` (str, optional): The RAG file ID
- `gcs_uri` (str, optional): The full GCS URI of the document (e.g., `'gs://bucket/path/to/file.md'`)
- `path` (str, optional): Relative path within the default bucket (e.g., `'documents/file.md'`)
- `bucket` (str, optional): Bucket name to use if path is provided (defaults to `segov-dev-bucket`)

**Examples:**
```python
# Retrieve using relative path (uses default bucket)
doc_get(path="documents/my-file.md")

# Retrieve using full GCS URI
doc_get(gcs_uri="gs://segov-dev-bucket/documents/my-file.md")

# Retrieve from different bucket using path
doc_get(path="docs/file.md", bucket="other-bucket")
```

**Returns:** Dictionary containing document content and metadata (size, content_type, updated timestamp)

## Deployment

See `../infra/` for Cloud Run deployment configurations.

## Notes

- The MCP server uses FastMCP's Streamable HTTP transport for remote access
- Ensure your Vertex AI RAG corpus is properly configured with a Vector Search index
- The service requires appropriate IAM roles: `roles/aiplatform.user`, `roles/storage.objectViewer`
- Default bucket (`segov-dev-bucket`) is configured in `env.example`. You can override it via `GCS_BUCKET_NAME` environment variable
- The bucket should be in the same region (`us-east1`) as your RAG corpus for optimal performance
