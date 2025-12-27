"""Cloud Run service-to-service authentication utilities."""
import logging
import time
from typing import Optional

import google.auth
import google.auth.transport.requests
from google.auth import impersonated_credentials
from google.oauth2 import id_token

logger = logging.getLogger(__name__)

# Cache token with expiry tracking
_token_cache: dict = {"token": None, "expiry": 0, "audience": None}
TOKEN_REFRESH_MARGIN = 300  # Refresh 5 min before expiry

# Service account to impersonate for local development
# This SA must have run.invoker permission on the target Cloud Run service
_IMPERSONATE_SA = "mcp-sa@segov-dev-model.iam.gserviceaccount.com"


def _fetch_id_token_with_impersonation(audience: str) -> Optional[str]:
    """Fetch ID token using service account impersonation.

    This works with user ADC credentials by impersonating a service account
    that has the necessary permissions.
    """
    try:
        # Get default credentials (user ADC or SA)
        source_credentials, _ = google.auth.default()

        # First, create impersonated credentials for the service account
        target_credentials = impersonated_credentials.Credentials(
            source_credentials=source_credentials,
            target_principal=_IMPERSONATE_SA,
            target_scopes=["https://www.googleapis.com/auth/cloud-platform"],
        )

        # Then create ID token credentials from the impersonated credentials
        id_token_credentials = impersonated_credentials.IDTokenCredentials(
            target_credentials,
            target_audience=audience,
            include_email=True,
        )

        # Refresh to get the token
        request = google.auth.transport.requests.Request()
        id_token_credentials.refresh(request)

        return id_token_credentials.token
    except Exception as e:
        logger.debug(f"Impersonation failed: {e}")
        return None


def get_id_token_for_url(target_url: str) -> Optional[str]:
    """Get ID token for a Cloud Run service URL.

    Tries multiple methods in order:
    1. fetch_id_token (works on GCP or with SA key)
    2. Service account impersonation (works with user ADC locally)

    Args:
        target_url: The Cloud Run service URL (e.g., https://service-xxx.run.app)

    Returns:
        ID token string, or None if not a Cloud Run URL or auth fails
    """
    if not target_url or ".run.app" not in target_url:
        return None

    # Extract audience (base URL without path)
    audience = target_url.rstrip("/").split("/v1")[0]

    now = time.time()
    cached = _token_cache
    if (cached["token"] and cached["audience"] == audience
            and cached["expiry"] > now + TOKEN_REFRESH_MARGIN):
        return cached["token"]

    token = None

    # Method 1: Try fetch_id_token (works on GCP or with SA key file)
    try:
        request = google.auth.transport.requests.Request()
        token = id_token.fetch_id_token(request, audience)
        logger.debug("Got ID token via fetch_id_token")
    except Exception as e:
        logger.debug(f"fetch_id_token failed: {e}")

    # Method 2: Try impersonation (works with user ADC locally)
    if not token:
        token = _fetch_id_token_with_impersonation(audience)
        if token:
            logger.debug("Got ID token via impersonation")

    if token:
        _token_cache["token"] = token
        _token_cache["expiry"] = now + 3600
        _token_cache["audience"] = audience
        return token

    logger.warning(f"Failed to get ID token for {audience}")
    return None


def get_auth_headers(base_url: Optional[str]) -> dict:
    """Get authorization headers for a base URL.

    Args:
        base_url: OpenAI-compatible API base URL

    Returns:
        Dict with Authorization header if applicable, empty dict otherwise
    """
    token = get_id_token_for_url(base_url) if base_url else None
    if token:
        return {"Authorization": f"Bearer {token}"}
    return {}
