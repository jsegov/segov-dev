"""MCP tools for Vertex AI RAG operations (read-only)."""
from typing import Any, Optional
from pathlib import Path
from vertexai import rag
from app.config import settings

# Whitelist of allowed file paths that can be accessed via MCP tools
# Only files in this list can be retrieved using the 'path' parameter
ALLOWED_MCP_PATHS = {
    'resume.md',  # Only resume.md is allowed for MCP tool access
}


def _validate_path(path: str) -> tuple[bool, str | None]:
    """
    Validate that a path is safe and allowed for MCP tool access.
    
    Args:
        path: Path to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not path:
        return False, 'Path cannot be empty'
    
    # Normalize the path
    normalized = Path(path).as_posix()
    
    # Prevent path traversal
    if '..' in normalized or normalized.startswith('/'):
        return False, 'Path traversal and absolute paths are not allowed'
    
    # Check if path is in the whitelist
    if normalized not in ALLOWED_MCP_PATHS:
        return False, f'Path "{normalized}" is not in the allowed whitelist for MCP tools'
    
    return True, None


def _validate_gcs_uri(gcs_uri: str) -> tuple[bool, str | None]:
    """
    Validate that a GCS URI is safe and within the allowed bucket.
    
    Args:
        gcs_uri: GCS URI to validate
        
    Returns:
        Tuple of (is_valid, error_message)
    """
    if not gcs_uri.startswith('gs://'):
        return False, 'GCS URI must start with gs://'
    
    # Extract bucket and path
    gcs_path = gcs_uri.replace('gs://', '')
    if '/' in gcs_path:
        bucket_name, blob_path = gcs_path.split('/', 1)
    else:
        return False, 'GCS URI must include a path component'
    
    # Ensure bucket matches the configured bucket
    if bucket_name != settings.gcs_bucket_name:
        return False, f'GCS URI must use the configured bucket: {settings.gcs_bucket_name}'
    
    # Prevent path traversal in blob path
    if '..' in blob_path:
        return False, 'Path traversal in GCS URI is not allowed'
    
    return True, None


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
    
    Security: Only whitelisted paths are allowed when using the 'path' parameter.
    This prevents access to internal files and unauthorized documents.

    Args:
        rag_file_id: The RAG file ID
        gcs_uri: The full GCS URI of the document (e.g., 'gs://bucket/path/to/file.md')
        path: Relative path within the default bucket (e.g., 'resume.md')
               Must be in the ALLOWED_MCP_PATHS whitelist
        bucket: Bucket name to use if path is provided (ignored - uses configured bucket)

    Returns:
        Dictionary containing document content and metadata, or error message
    """
    if not rag_file_id and not gcs_uri and not path:
        return {'error': 'Either rag_file_id, gcs_uri, or path must be provided'}

    # Validate path if provided
    if path:
        is_valid, error_msg = _validate_path(path)
        if not is_valid:
            return {'error': f'Invalid path: {error_msg}'}
        
        # Construct GCS URI from validated path
        path = path.lstrip('/')
        gcs_uri = f'gs://{settings.gcs_bucket_name}/{path}'
    
    # Validate GCS URI if provided
    if gcs_uri:
        is_valid, error_msg = _validate_gcs_uri(gcs_uri)
        if not is_valid:
            return {'error': f'Invalid GCS URI: {error_msg}'}

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
        # RAG file IDs are managed by Vertex AI RAG Engine
        # They can only reference files that were ingested into the RAG corpus
        # No additional validation needed as Vertex AI controls the namespace
        
        # Strategy: Use vector search to find chunks from this file ID
        # The source_uri from the search results will point to the GCS location
        # Note: If rag_file_id is itself a GCS URI, we'll handle it that way
        
        # Check if rag_file_id looks like a GCS URI
        if rag_file_id.startswith('gs://'):
            # Treat as GCS URI and validate/fetch
            is_valid, error_msg = _validate_gcs_uri(rag_file_id)
            if not is_valid:
                return {'error': f'Invalid GCS URI: {error_msg}'}
            
            from google.cloud import storage
            client = storage.Client(project=settings.project_id)
            gcs_path = rag_file_id.replace('gs://', '')
            if '/' in gcs_path:
                bucket_name, blob_path = gcs_path.split('/', 1)
            else:
                return {'error': f'Invalid GCS URI: {rag_file_id}. Expected format: gs://bucket/path'}
            
            gcs_bucket = client.bucket(bucket_name)
            blob = gcs_bucket.blob(blob_path)
            
            if not blob.exists():
                return {'error': f'File not found: {rag_file_id}'}
            
            content = blob.download_as_text()
            return {
                'rag_file_id': rag_file_id,
                'uri': rag_file_id,
                'content': content,
                'metadata': {
                    'size': len(content),
                    'content_type': blob.content_type,
                    'updated': blob.updated.isoformat() if blob.updated else None,
                },
            }
        
        # Otherwise, use vector search to find the source URI
        # Strategy: Use the rag_file_id as a query to find matching chunks
        # The source_uri from results will point to the GCS location of the file
        try:
            # First, try using the rag_file_id directly as the query
            # This works if the file ID appears in document content, filename, or metadata
            retrieval_config = rag.RagRetrievalConfig(top_k=20)
            
            response = rag.retrieval_query(
                rag_resources=[rag.RagResource(rag_corpus=settings.rag_corpus_name)],
                query_text=rag_file_id,
                retrieval_config=retrieval_config,
            )
            
            # Look for chunks that match this file ID
            source_uri = None
            if response.contexts:
                for ctx in response.contexts:
                    if not ctx.source_uri:
                        continue
                    
                    # Check if the file ID matches the source_uri (filename or path)
                    # RAG file IDs might be the filename, full path, or GCS URI suffix
                    source_filename = ctx.source_uri.split('/')[-1]
                    source_path = ctx.source_uri
                    
                    if (rag_file_id == source_filename or
                        rag_file_id in source_path or
                        source_path.endswith(rag_file_id) or
                        rag_file_id.endswith(source_filename)):
                        source_uri = ctx.source_uri
                        break
                    
                    # Also check metadata for file ID
                    if ctx.metadata:
                        metadata_str = str(ctx.metadata).lower()
                        if rag_file_id.lower() in metadata_str:
                            source_uri = ctx.source_uri
                            break
                
                # If we found results but no exact match, use the first result's source_uri
                # This assumes the query matched content from the target file
                if not source_uri and response.contexts[0].source_uri:
                    source_uri = response.contexts[0].source_uri
            
            if not source_uri:
                return {
                    'error': f'Could not find source URI for RAG file ID: {rag_file_id}',
                    'rag_file_id': rag_file_id,
                    'note': 'File may not exist in the RAG corpus or file ID format is not recognized',
                }
            
            # Validate and fetch from GCS
            is_valid, error_msg = _validate_gcs_uri(source_uri)
            if not is_valid:
                return {
                    'error': f'Invalid source URI found: {error_msg}',
                    'rag_file_id': rag_file_id,
                    'source_uri': source_uri,
                }
            
            from google.cloud import storage
            client = storage.Client(project=settings.project_id)
            gcs_path = source_uri.replace('gs://', '')
            if '/' in gcs_path:
                bucket_name, blob_path = gcs_path.split('/', 1)
            else:
                return {'error': f'Invalid source URI format: {source_uri}'}
            
            gcs_bucket = client.bucket(bucket_name)
            blob = gcs_bucket.blob(blob_path)
            
            if not blob.exists():
                return {
                    'error': f'File not found at source URI: {source_uri}',
                    'rag_file_id': rag_file_id,
                    'source_uri': source_uri,
                }
            
            content = blob.download_as_text()
            return {
                'rag_file_id': rag_file_id,
                'uri': source_uri,
                'content': content,
                'metadata': {
                    'size': len(content),
                    'content_type': blob.content_type,
                    'updated': blob.updated.isoformat() if blob.updated else None,
                },
            }
            
        except Exception as e:
            return {
                'error': f'Failed to retrieve document by RAG file ID: {str(e)}',
                'rag_file_id': rag_file_id,
            }
    
    return {'error': 'No valid identifier provided'}

