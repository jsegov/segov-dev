"""Dependencies and initialization for Vertex AI."""
from google.cloud import aiplatform
import vertexai


def init_vertex_ai(project_id: str, location: str) -> None:
    """Initialize Vertex AI with project and location."""
    vertexai.init(project=project_id, location=location)
    aiplatform.init(project=project_id, location=location)

