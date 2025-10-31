# MCP Server GCP CR

---

## **Reference architecture (prototype)**

**Data plane**

1. **GCS bucket** with your Markdown files.
2. **Vertex AI RAG Engine** corpus that is configured to use **Vertex AI Vector Search** as its vector DB (streaming index).
3. Optional: Pub/Sub notifications on bucket changes (auto‑ingest on new/updated objects).

**Serving plane**

4. **MCP server (Cloud Run)** exposing tools:

- ingest.from_gcs(prefix|uris, chunk_size, overlap) → calls rag.import_files(...)
- vector.search(query, top_k, filter) → calls RAG retrieval or Vector Search NN query
- doc.get(id) → returns source/metadata
1. **Your chatbot client**:
    - If using **OpenAI SDK → OpenAI models** (Responses API), you can attach **hosted MCP**.
    - If using **OpenAI SDK → vLLM (OpenAI‑compatible)** on Vertex AI, you must run an **MCP client** in your app to bridge tool calls to your Cloud Run MCP server.

---

## **Step‑by‑step implementation plan**

### **0) Enable services, create infra, and set roles**

- **APIs**: Vertex AI, Cloud Run, Pub/Sub, Eventarc, Cloud Storage, (Firestore if you want a docstore), Secrets Manager (if needed).
- **GCS bucket**: create (regional, same region as Vertex AI index).
- **Pub/Sub**: create a topic for bucket notifications (optional but recommended for auto‑ingest).
    - Configure **GCS Pub/Sub notifications** for OBJECT_FINALIZE events on your bucket.
- **Cloud Run** service accounts**:
    - mcp-sa: roles/aiplatform.user, roles/storage.objectViewer, and roles/run.invoker.
    - If your MCP server will **create** indexes/endpoints itself, grant the minimal additional Vertex roles necessary, or pre‑provision the index (recommended for prototype).
- **Cloud Run Pub/Sub trigger** for an “indexer” endpoint (if using auto‑ingest): create Eventarc trigger for your topic to invoke your service.

> Notes
> 

> • Pub/Sub delivers at‑least‑once; make the ingestion handler idempotent (e.g., upsert by object generation).
> 

---

### **1) Create the Vector Search index & connect it to a RAG corpus**

1. **Create a Vector Search index** compatible with your embedding model and **enable STREAM_UPDATE**:
    - Distance: DOT_PRODUCT or COSINE (both supported for RAG integration).
    - Dimension must match the embedding model.
        - text‑embedding‑005: **up to 768** dims.
        - gemini‑embedding‑001: **up to 3072** dims (configurable via outputDimensionality).
2. **Create & deploy an index endpoint**, then **associate it with a RAG corpus**:
    - RAG Engine provides a documented flow: create (empty) Vector Search index → deploy to endpoint → create a **RAG corpus** that references INDEX_NAME + INDEX_ENDPOINT_NAME (numeric IDs).

> Tip: first‑time index deployment may take ~initial backend spin‑up before it’s ready; subsequent deploys are fast.
> 

---

### **2) Ingest Markdown from GCS using the RAG API (recommended)**

Use the **RAG Engine Import** API to handle chunking + embedding + indexing:

- **Create the corpus** with your embedding preference (examples below use Python SDK):

```
from vertexai import rag
import vertexai

vertexai.init(project=PROJECT_ID, location="us-central1")

embedding_model_config = rag.RagEmbeddingModelConfig(
    vertex_prediction_endpoint=rag.VertexPredictionEndpoint(
        publisher_model="publishers/google/models/text-embedding-005"  # or gemini-embedding-001
    )
)

rag_corpus = rag.create_corpus(
    display_name="md-corpus",
    backend_config=rag.RagVectorDbConfig(
        rag_embedding_model_config=embedding_model_config
    ),
)
```

- **Import from GCS and configure chunking**:

```
rag.import_files(
    rag_corpus.name,
    paths=["gs://YOUR_BUCKET/path_or_prefix"],
    transformation_config=rag.TransformationConfig(
        chunking_config=rag.ChunkingConfig(chunk_size=512, chunk_overlap=100)
    ),
    max_embedding_requests_per_min=900,  # throttle as needed
)
```

This triggers chunking, embedding (with the embedding model you set), and index updates to the **Vertex AI Vector Search** index attached to the corpus.

> Alternative (build‑your‑own): You can call the
> 
> 
> **Text Embeddings API**
> 

---

### **3) Retrieval: two practical options**

- **(A) RAG retrieval API** (fastest to wire):
    
    Call rag.retrieval_query() on your corpus for top‑K results (with optional filter and distance threshold). This returns the matched chunks + metadata that you can return from your MCP tool.
    
- **(B) Direct Vector Search “nearest neighbors”**:
    
    Query the **Matching Engine** index endpoint (use the appropriate “find neighbors” method) and post‑process payloads from your docstore (if you keep sources/metadata elsewhere). For the prototype, **(A)** is simpler and fully managed.
    

---

### **4) Build the MCP server (Cloud Run)**

**Technology choices**

- **Language**: Python (MCP Python SDK’s FastMCP) or Node.
- **Transport**: for Cloud Run, use **remote MCP over HTTP (SSE/WebSocket)** rather than stdio (stdio is ideal for local dev). See the **remote servers** guide for clients that can connect to internet‑hosted MCP servers.

**Tools to expose**

- vector.search
    
    **Input**: query: str, top_k: int=5, filter: {...} (optional)
    
    **Action**: call rag.retrieval_query on your corpus (with filter/distance threshold), return structured hits (text, score, source_uri, chunk_id, metadata).
    
- ingest.from_gcs
    
    **Input**: uris_or_prefix: list[str], chunking params
    
    **Action**: call rag.import_files to (re)ingest markdown.
    
- doc.get
    
    **Input**: rag_file_id OR gcs_uri
    
    **Action**: fetch the original file or chunk text to show provenance.
    

**Skeleton (Python, FastMCP)**

```
# app.py
import os
from typing import Any
from mcp.server.fastmcp import FastMCP

from vertexai import rag
import vertexai

PROJECT = os.environ["PROJECT_ID"]
LOCATION = os.environ.get("LOCATION", "us-central1")
CORPUS_NAME = os.environ["RAG_CORPUS_NAME"]

vertexai.init(project=PROJECT, location=LOCATION)
mcp = FastMCP("vertex-rag-mcp")

@mcp.tool()
def vector_search(query: str, top_k: int = 5, distance_threshold: float | None = None) -> dict[str, Any]:
    retrieval_cfg = rag.RagRetrievalConfig(
        top_k=top_k,
        filter=rag.Filter(vector_distance_threshold=distance_threshold) if distance_threshold else None,
    )
    resp = rag.retrieval_query(
        rag_resources=[rag.RagResource(rag_corpus=CORPUS_NAME)],
        query=query,
        retrieval_config=retrieval_cfg,
    )
    # map resp to MCP-friendly schema
    return {"matches": [ ... ]}

@mcp.tool()
def ingest_from_gcs(paths: list[str], chunk_size: int = 512, chunk_overlap: int = 100) -> str:
    rag.import_files(
        CORPUS_NAME,
        paths,
        transformation_config=rag.TransformationConfig(
            chunking_config=rag.ChunkingConfig(chunk_size=chunk_size, chunk_overlap=chunk_overlap),
        ),
    )
    return "OK"

def main():
    # For Cloud Run, run with HTTP/SSE transport (remote MCP).
    # Use the MCP SDK’s documented HTTP/SSE server startup (or a small ASGI wrapper around FastMCP).
    # For local testing you can do: mcp.run(transport='stdio')
    ...
```

- The **MCP “build a server”** doc shows tool registration patterns and the FastMCP quickstart; for Cloud Run you’ll adapt the transport for remote usage per the **remote MCP** guide.

**Dockerfile** (minimal)

```
FROM python:3.11-slim
WORKDIR /app
COPY pyproject.toml poetry.lock* /app/
RUN pip install --no-cache-dir "mcp[cli]" google-cloud-aiplatform google-auth
COPY . /app
CMD ["python", "app.py"]
```

**Deploy to Cloud Run** (example)

```
gcloud run deploy vertex-rag-mcp \
  --source . \
  --service-account mcp-sa@${PROJECT_ID}.iam.gserviceaccount.com \
  --set-env-vars PROJECT_ID=${PROJECT_ID},LOCATION=us-central1,RAG_CORPUS_NAME=${RAG_CORPUS_NAME} \
  --region us-central1 --allow-unauthenticated=false
```

---

### **5) Event‑driven auto‑ingest (optional but useful)**

- Configure **GCS → Pub/Sub** notifications for OBJECT_FINALIZE.
- Eventarc trigger calls a Cloud Run **ingester** endpoint that invokes your ingest.from_gcs MCP tool (or directly calls the RAG API) with the affected object URI.

---

### **6) Query path from the chatbot**

You have two distinct choices depending on the model endpoint:

**Path A — OpenAI models (hosted MCP by OpenAI)**

Use OpenAI’s **Responses API** with **hosted MCP connectors**. Your Cloud Run MCP server will be a **remote MCP** tool. The model will directly enumerate tools and invoke them—no bridge code needed. (Only applies to certain OpenAI models.)

**Path B — vLLM on Vertex AI (OpenAI‑compatible Chat Completions)**

- Vertex AI supports an **OpenAI‑compatible Chat Completions API** for Google models and select **vLLM**/TGI containers. That’s why you can point the official **OpenAI SDK** to Vertex’s base URL and “just work.”
- However, **hosted MCP** is not available in that scenario because you’re not calling OpenAI’s Responses API. You must run an **MCP client** in your app to list & call your Cloud Run MCP tools, and then feed tool results back into the model via the usual function/tool‑calling pattern (or direct content injection). Libraries exist to help agents use MCP tools (e.g., LangChain adapters for MCP).

> Practical setup for Path B
> 
1. Start your chatbot with the **OpenAI SDK** but set base_url to your **Vertex Chat Completions** endpoint (or the Vertex‑hosted vLLM endpoint).
2. Define **function/tool schemas** in your chat request that correspond to MCP tools (vector.search, ingest.from_gcs).
3. When the model emits a **tool call**, your app uses an **MCP client** (Python/Node) to call your **Cloud Run MCP server**, then sends the tool result back to the model as a follow‑up message.
4. Return the final model message to the user.

> FYI: vLLM itself
> 
> 
> **exposes OpenAI‑compatible APIs**
> 
> **prebuilt vLLM**
> 

---

## **Design details & recommendations**

### **Embedding model choice & vector dimensions**

- If you want **best quality** (especially multilingual), **gemini‑embedding‑001** is the current “large” embedding model; default **3072‑d**, but you can set outputDimensionality to 1536 or 768 to save space with little loss (Matryoshka behavior).
- If you want a **compact, cost‑efficient index**, **text‑embedding‑005** uses **up to 768‑d** vectors; good default for English‑heavy corpora. Your Vector Search index **dimension must match** the chosen embedding.

### **Filters & metadata**

- When importing with RAG Engine, include metadata (source URI, path, tags). At query time you can apply **filters** or a **vector distance threshold** with RAG retrieval. (Direct Vector Search also supports structured filters.)

### **Security**

- Keep the **MCP server private** (Cloud Run **authenticated invokers** only) and issue **user‑level auth** via your chatbot backend (e.g., signed JWT → OIDC to Cloud Run). See Cloud Run auth patterns.

### **Observability**

- Log MCP tool calls (parameters & latency) in Cloud Run logs; log retrieval top_k, distance, and whether a **rerank** pass is used (optional).
- Vertex AI & RAG Engine requests appear in **Cloud Logging** and quotas pages; monitor **index QPS** and **latency**.

---

## **Testing checklist**

1. **Unit test** MCP tools locally with stdio transport (FastMCP tutorial), then switch to HTTP/SSE for Cloud Run.
2. **Smoke test** ingestion from a small gs://bucket/folder (5–10 MD files), verify the files appear as RAG files and that retrieval returns those chunks.
3. **E2E chatbot**:
    - **Path A (OpenAI)**: attach hosted MCP and ask a question grounded in your MD files; verify tool is called automatically.
    - **Path B (vLLM on Vertex)**: run your MCP client bridge; check that model emits a tool call and the bridge executes it against your Cloud Run MCP server; confirm the final answer cites your sources.

---

## **What changes in production**

- **Cold start + scale**: give the MCP service a minimum instance and tune concurrency.
- **Index lifecycle**: RAG Engine supports import throttling and you can shift to **stream update** for near‑real‑time refreshes.
- **Reranking**: add a fast reranker stage for higher precision on long‑tail questions.
- **Access control**: map user identity → filter expression (e.g., per‑team docs).
- **Backfill**: one‑time large corpus import using rag.import_files from a manifest of GCS URIs.

---

## **Key documentation used (selected)**

- **RAG Engine** quickstart & APIs (create corpus, import files, retrieval): Google Cloud docs.
- **Use Vertex AI Vector Search with RAG Engine** (create streaming index, endpoint, associate to corpus).
- **Text Embeddings API** (models, dimensions, task_type, outputDimensionality).
- **OpenAI‑compatible Chat Completions on Vertex AI** (Gemini/vLLM containers supported; how to use OpenAI libraries against Vertex).
- **MCP basics, building servers, remote MCP**: Model Context Protocol docs.
- **OpenAI hosted MCP tooling scope** (only with Responses API on supported models): OpenAI Agents SDK / MCP guide.
- **GCS → Pub/Sub notifications** and **Cloud Run Pub/Sub triggers (Eventarc)**.

---

## **Direct answers to your questions**

1. **Is this possible?**
    
    **Yes.** Use RAG Engine to ingest from GCS into **Vertex AI Vector Search**, then expose retrieval as **MCP tools** via a Cloud Run service. Your chatbot can call those tools either via **OpenAI hosted MCP** (if you’re actually calling OpenAI models with Responses API) or via an **in‑app MCP client bridge** (if you’re using vLLM on Vertex).
    
2. **Is this the optimal path? If not, what is?**
    
    For a **prototype**, the **optimal** path is:
    
    - **Use RAG Engine’s import pipeline** (less code, robust chunking/embedding/indexing).
    - **Expose a minimal MCP surface** (vector.search, ingest.from_gcs).
    - For **OpenAI‑model chat**, use **hosted MCP**; for **vLLM on Vertex**, **bridge MCP** in your app.
        
        This minimizes engineering risk while keeping your deployment fully on GCP and MCP‑compatible.
        

---