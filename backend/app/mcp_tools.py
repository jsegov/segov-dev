"""MCP tools for Vertex AI RAG operations."""
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
        query=query,
        retrieval_config=retrieval_config,
    )

    matches = []
    if hasattr(response, 'contexts') and response.contexts:
        for ctx in response.contexts:
            match = {
                'text': getattr(ctx, 'text', ''),
                'score': getattr(ctx, 'score', 0.0),
                'source_uri': getattr(ctx, 'source_uri', ''),
                'chunk_id': getattr(ctx, 'chunk_id', ''),
            }
            if hasattr(ctx, 'metadata') and ctx.metadata:
                match['metadata'] = dict(ctx.metadata)
            matches.append(match)

    return {'matches': matches}


async def ingest_from_gcs(
    paths: list[str],
    chunk_size: int = 512,
    chunk_overlap: int = 100,
    max_embedding_requests_per_min: int = 900,
) -> dict[str, Any]:
    """
    Ingest documents from GCS into the RAG corpus.

    Args:
        paths: List of GCS URIs or prefixes (e.g., ['gs://bucket/path'])
        chunk_size: Size of text chunks (default: 512)
        chunk_overlap: Overlap between chunks (default: 100)
        max_embedding_requests_per_min: Rate limit for embeddings (default: 900)

    Returns:
        Dictionary with ingestion status
    """
    transformation_config = rag.TransformationConfig(
        chunking_config=rag.ChunkingConfig(
            chunk_size=chunk_size, chunk_overlap=chunk_overlap
        )
    )

    result = rag.import_files(
        corpus_name=settings.rag_corpus_name,
        paths=paths,
        transformation_config=transformation_config,
        max_embedding_requests_per_min=max_embedding_requests_per_min,
    )

    return {
        'status': 'success',
        'message': 'Files imported successfully',
        'import_result': str(result) if result else None,
    }


async def doc_get(
    rag_file_id: Optional[str] = None,
    gcs_uri: Optional[str] = None,
) -> dict[str, Any]:
    """
    Retrieve a document by RAG file ID or GCS URI.

    Args:
        rag_file_id: The RAG file ID
        gcs_uri: The GCS URI of the document

    Returns:
        Dictionary containing document content and metadata
    """
    if not rag_file_id and not gcs_uri:
        return {'error': 'Either rag_file_id or gcs_uri must be provided'}

    # If GCS URI is provided, fetch directly from GCS
    if gcs_uri:
        from google.cloud import storage

        client = storage.Client(project=settings.project_id)
        bucket_name, blob_path = gcs_uri.replace('gs://', '').split('/', 1)
        bucket = client.bucket(bucket_name)
        blob = bucket.blob(blob_path)

        content = blob.download_as_text()
        return {
            'uri': gcs_uri,
            'content': content,
            'metadata': {
                'size': len(content),
                'content_type': blob.content_type,
            },
        }

    # If RAG file ID is provided, fetch from RAG corpus
    # Note: This is a placeholder - actual implementation depends on RAG API
    return {
        'rag_file_id': rag_file_id,
        'note': 'RAG file retrieval by ID requires additional RAG API calls',
    }

