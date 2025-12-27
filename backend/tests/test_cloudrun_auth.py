"""Tests for Cloud Run authentication utilities."""
from unittest.mock import patch
from app.cloudrun_auth import get_id_token_for_url, get_auth_headers, _token_cache


class TestGetIdTokenForUrl:
    def setup_method(self):
        # Reset cache between tests
        _token_cache["token"] = None
        _token_cache["expiry"] = 0

    def test_returns_none_for_non_cloudrun_url(self):
        assert get_id_token_for_url("https://api.openai.com/v1") is None
        assert get_id_token_for_url("http://localhost:8000") is None
        assert get_id_token_for_url(None) is None

    def test_returns_none_for_empty_url(self):
        assert get_id_token_for_url("") is None

    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_fetches_token_for_cloudrun_url(self, mock_fetch):
        mock_fetch.return_value = "test-token"
        token = get_id_token_for_url("https://vllm-inference-xxx.run.app/v1")
        assert token == "test-token"
        mock_fetch.assert_called_once()

    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_extracts_correct_audience(self, mock_fetch):
        mock_fetch.return_value = "test-token"
        get_id_token_for_url("https://vllm-inference-xxx.run.app/v1")
        # Should extract base URL without /v1 path
        call_args = mock_fetch.call_args
        assert call_args[0][1] == "https://vllm-inference-xxx.run.app"

    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_caches_token(self, mock_fetch):
        mock_fetch.return_value = "cached-token"
        get_id_token_for_url("https://service.run.app")
        get_id_token_for_url("https://service.run.app")
        assert mock_fetch.call_count == 1

    @patch("app.cloudrun_auth._fetch_id_token_with_impersonation")
    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_returns_none_on_auth_failure(self, mock_fetch, mock_impersonate):
        mock_fetch.side_effect = Exception("Auth failed")
        mock_impersonate.return_value = None
        token = get_id_token_for_url("https://service.run.app")
        assert token is None


class TestGetAuthHeaders:
    def setup_method(self):
        _token_cache["token"] = None
        _token_cache["expiry"] = 0

    def test_returns_empty_for_non_cloudrun(self):
        assert get_auth_headers("https://api.openai.com/v1") == {}
        assert get_auth_headers(None) == {}

    def test_returns_empty_for_empty_url(self):
        assert get_auth_headers("") == {}

    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_returns_bearer_header_for_cloudrun(self, mock_fetch):
        mock_fetch.return_value = "my-token"
        headers = get_auth_headers("https://vllm.run.app/v1")
        assert headers == {"Authorization": "Bearer my-token"}

    @patch("app.cloudrun_auth._fetch_id_token_with_impersonation")
    @patch("app.cloudrun_auth.id_token.fetch_id_token")
    def test_returns_empty_on_auth_failure(self, mock_fetch, mock_impersonate):
        mock_fetch.side_effect = Exception("Auth failed")
        mock_impersonate.return_value = None
        headers = get_auth_headers("https://vllm.run.app/v1")
        assert headers == {}
