"""Configuration settings for the MCP backend."""
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    project_id: str = Field(..., alias='PROJECT_ID')
    location: str = Field(default='us-central1', alias='LOCATION')
    rag_corpus_name: str = Field(..., alias='RAG_CORPUS_NAME')
    port: int = Field(default=8080, alias='PORT')

    class Config:
        env_file = '.env'
        case_sensitive = False


settings = Settings()

