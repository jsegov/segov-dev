"""MCP tools for Vertex AI RAG operations (read-only)."""
from typing import Any, Optional
from vertexai import rag
from app.config import settings


async def vector_search(
    query: str,
    top_k: int = 5,
    distance_threshold: Optional[float] = None,
) -> dict[str, Any]:
    """
    Search for relevant documents using vector search.

    Args:
        query: The search query string
        top_k: Number of results to return (default: 5)
        distance_threshold: Optional distance threshold for filtering results

    Returns:
        Dictionary containing matched documents with metadata
    """
    retrieval_config = rag.RagRetrievalConfig(
        top_k=top_k,
        filter=rag.Filter(vector_distance_threshold=distance_threshold)
        if distance_threshold
        else None,
    )

    response = rag.retrieval_query(
        rag_resources=[rag.RagResource(rag_corpus=settings.rag_corpus_name)],
        query_text=query,
        retrieval_config=retrieval_config,
    )

    matches = []
    if response.contexts:
        for ctx in response.contexts:
            match = {
                'text': ctx.text,
                'score': ctx.score,
                'source_uri': ctx.source_uri,
                'chunk_id': ctx.chunk_id,
            }
            if ctx.metadata:
                match['metadata'] = dict(ctx.metadata)
            matches.append(match)

    return {'matches': matches}


async def doc_get(
    rag_file_id: Optional[str] = None,
    gcs_uri: Optional[str] = None,
    path: Optional[str] = None,
    bucket: Optional[str] = None,
) -> dict[str, Any]:
    """
    Retrieve a document by RAG file ID or GCS URI.

    Args:
        rag_file_id: The RAG file ID
        gcs_uri: The full GCS URI of the document (e.g., 'gs://bucket/path/to/file.md')
        path: Relative path within the default bucket (e.g., 'documents/file.md')
        bucket: Bucket name to use if path is provided without bucket

    Returns:
        Dictionary containing document content and metadata
    """
    if not rag_file_id and not gcs_uri and not path:
        return {'error': 'Either rag_file_id, gcs_uri, or path must be provided'}

    if path and not gcs_uri:
        bucket_name = bucket or settings.gcs_bucket_name
        path = path.lstrip('/')
        gcs_uri = f'gs://{bucket_name}/{path}'

    if gcs_uri:
        from google.cloud import storage

        client = storage.Client(project=settings.project_id)
        gcs_path = gcs_uri.replace('gs://', '')
        if '/' in gcs_path:
            bucket_name, blob_path = gcs_path.split('/', 1)
        else:
            return {'error': f'Invalid GCS URI: {gcs_uri}. Expected format: gs://bucket/path'}
        
        gcs_bucket = client.bucket(bucket_name)
        blob = gcs_bucket.blob(blob_path)

        if not blob.exists():
            return {'error': f'File not found: {gcs_uri}'}

        content = blob.download_as_text()
        return {
            'uri': gcs_uri,
            'content': content,
            'metadata': {
                'size': len(content),
                'content_type': blob.content_type,
                'updated': blob.updated.isoformat() if blob.updated else None,
            },
        }

    if rag_file_id:
        return {
            'rag_file_id': rag_file_id,
            'note': 'RAG file retrieval by ID requires additional RAG API calls',
        }
    
    return {'error': 'No valid identifier provided'}

