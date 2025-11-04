"""Helper functions for RAG corpus ingestion (not exposed via MCP)."""
from typing import Any, Optional
from vertexai import rag
from app.config import settings


async def ingest_from_gcs(
    paths: list[str] | None = None,
    prefix: str | None = None,
    chunk_size: int = 512,
    chunk_overlap: int = 100,
    max_embedding_requests_per_min: int = 900,
    bucket: str | None = None,
) -> dict[str, Any]:
    """
    Ingest documents from GCS into the RAG corpus.

    This is a helper function for administrative use, not exposed via MCP tools.

    Args:
        paths: List of GCS URIs or prefixes (e.g., ['gs://bucket/path']). If None and prefix is provided, uses prefix.
        prefix: GCS prefix to ingest all files matching (e.g., 'documents/'). Uses default bucket if bucket not specified.
        chunk_size: Size of text chunks (default: 512)
        chunk_overlap: Overlap between chunks (default: 100)
        max_embedding_requests_per_min: Rate limit for embeddings (default: 900)
        bucket: Bucket name to use if prefix is provided without bucket. Defaults to configured bucket.

    Returns:
        Dictionary with ingestion status
    """
    if prefix:
        bucket_name = bucket or settings.gcs_bucket_name
        if prefix.startswith('gs://'):
            paths_to_use = [prefix]
        else:
            if '/' not in prefix or not prefix.startswith(('gs://', bucket_name)):
                full_path = f'gs://{bucket_name}/{prefix}'
            else:
                full_path = prefix
            paths_to_use = [full_path]
    elif paths:
        paths_to_use = paths
    else:
        paths_to_use = [f'gs://{settings.gcs_bucket_name}/']

    transformation_config = rag.TransformationConfig(
        chunking_config=rag.ChunkingConfig(
            chunk_size=chunk_size, chunk_overlap=chunk_overlap
        )
    )

    result = rag.import_files(
        corpus_name=settings.rag_corpus_name,
        paths=paths_to_use,
        transformation_config=transformation_config,
        max_embedding_requests_per_min=max_embedding_requests_per_min,
    )

    return {
        'status': 'success',
        'message': f'Files imported successfully from {len(paths_to_use)} path(s)',
        'paths_ingested': paths_to_use,
        'import_result': str(result) if result else None,
    }





