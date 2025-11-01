"""Configuration settings for the MCP backend."""
from pydantic_settings import BaseSettings
from pydantic import Field
import warnings


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    project_id: str = Field(
        default='your-gcp-project-id',
        alias='PROJECT_ID'
    )
    location: str = Field(default='us-east1', alias='LOCATION')
    rag_corpus_name: str = Field(
        default='projects/your-project-id/locations/us-east1/ragCorpora/your-corpus-id',
        alias='RAG_CORPUS_NAME'
    )
    gcs_bucket_name: str = Field(
        default='segov-dev-bucket',
        alias='GCS_BUCKET_NAME'
    )
    port: int = Field(default=8080, alias='PORT')
    google_application_credentials: str | None = Field(
        default=None,
        alias='GOOGLE_APPLICATION_CREDENTIALS',
        description='Path to service account JSON key file (optional, uses ADC if not set)'
    )
    mcp_require_auth: bool = Field(
        default=False,
        alias='MCP_REQUIRE_AUTH',
        description='Enable MCP authentication (default: False for local testing). When enabled, requires FastMCP 2.0 auth provider implementation.'
    )
    mcp_token_issuer: str = Field(
        default='http://localhost:8080',
        alias='MCP_TOKEN_ISSUER',
        description='Token issuer URL for JWT validation (reserved for future auth provider implementation)'
    )
    mcp_token_audience: str = Field(
        default='vertex-rag-mcp',
        alias='MCP_TOKEN_AUDIENCE',
        description='Token audience for JWT validation (reserved for future auth provider implementation)'
    )
    mcp_public_key: str | None = Field(
        default=None,
        alias='MCP_PUBLIC_KEY',
        description='Public key (PEM format) for JWT verification (reserved for future auth provider implementation)'
    )
    mcp_private_key: str | None = Field(
        default=None,
        alias='MCP_PRIVATE_KEY',
        description='Private key (PEM format) for JWT signing (reserved for future auth provider implementation)'
    )

    class Config:
        env_file = '.env'
        case_sensitive = False

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        if self.project_id == 'your-gcp-project-id':
            warnings.warn(
                'Using default PROJECT_ID. Set PROJECT_ID environment variable for production.',
                UserWarning
            )
        if 'your-project-id' in self.rag_corpus_name or 'your-corpus-id' in self.rag_corpus_name:
            warnings.warn(
                'Using default RAG_CORPUS_NAME. Set RAG_CORPUS_NAME environment variable for production.',
                UserWarning
            )


settings = Settings()

