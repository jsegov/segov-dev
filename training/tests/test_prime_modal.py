"""Tests for the post-deploy Modal snapshot primer."""

import io
import json
import socket
import urllib.error

import pytest

from deploy.prime_modal import (
    ModalPrimeError,
    parse_inference_headers,
    prime_modal_endpoint,
)


class Response(io.BytesIO):
    def __init__(self, payload, status=200):
        super().__init__(json.dumps(payload).encode())
        self.status = status
        self.headers = {}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def successful_response():
    return Response({"choices": [{"message": {"content": "READY"}}]})


def test_retries_503_and_client_timeout_before_completion():
    outcomes = [
        urllib.error.HTTPError("https://modal", 503, "warming", None, None),
        socket.timeout("restore still in progress"),
        successful_response(),
    ]

    def urlopen(_request, timeout):
        assert timeout > 0
        assert _request.full_url == "https://example.modal.direct/v1/chat/completions"
        assert _request.get_header("Modal-key") == "key"
        assert _request.get_header("Modal-secret") == "secret"
        request_body = json.loads(_request.data)
        assert request_body["model"] == "ama"
        assert request_body["stream"] is False
        outcome = outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    attempts = prime_modal_endpoint(
        base_url="https://example.modal.direct/v1",
        model="ama",
        headers={"Modal-Key": "key", "Modal-Secret": "secret"},
        timeout_seconds=60,
        retry_delay_seconds=0,
        urlopen=urlopen,
    )

    assert attempts == 3


@pytest.mark.parametrize("status", [401, 403, 404, 500])
def test_stops_immediately_on_terminal_http_errors(status):
    def urlopen(_request, timeout):
        raise urllib.error.HTTPError("https://modal", status, "terminal", None, None)

    with pytest.raises(ModalPrimeError, match=f"terminal HTTP {status}"):
        prime_modal_endpoint(
            base_url="https://example.modal.direct/v1",
            model="ama",
            headers={},
            urlopen=urlopen,
        )


def test_rejects_an_empty_success_response():
    with pytest.raises(ModalPrimeError, match="without a non-empty completion"):
        prime_modal_endpoint(
            base_url="https://example.modal.direct/v1",
            model="ama",
            headers={},
            urlopen=lambda _request, timeout: Response(
                {"choices": [{"message": {"content": ""}}]}
            ),
        )


def test_rejects_invalid_json_success_response():
    invalid_response = Response({})
    invalid_response.seek(0)
    invalid_response.truncate()
    invalid_response.write(b"{")
    invalid_response.seek(0)

    with pytest.raises(ModalPrimeError, match="returned invalid JSON"):
        prime_modal_endpoint(
            base_url="https://example.modal.direct/v1",
            model="ama",
            headers={},
            urlopen=lambda _request, timeout: invalid_response,
        )


def test_rejects_non_timeout_network_errors():
    def urlopen(_request, timeout):
        raise urllib.error.URLError("dns failure")

    with pytest.raises(ModalPrimeError, match="network request failed"):
        prime_modal_endpoint(
            base_url="https://example.modal.direct/v1",
            model="ama",
            headers={},
            urlopen=urlopen,
        )


def test_stops_retrying_when_the_startup_budget_expires():
    timestamps = iter([0, 0, 1, 1, 1])

    def urlopen(_request, timeout):
        raise urllib.error.HTTPError("https://modal", 503, "warming", None, None)

    with pytest.raises(ModalPrimeError, match="within 1.0s after 1 attempts"):
        prime_modal_endpoint(
            base_url="https://example.modal.direct/v1",
            model="ama",
            headers={},
            timeout_seconds=1,
            retry_delay_seconds=0,
            urlopen=urlopen,
            monotonic=lambda: next(timestamps),
        )


def test_parses_proxy_and_bearer_headers():
    assert parse_inference_headers(
        '{"Modal-Key":"wk-test","Modal-Secret":"ws-test"}', "api-key"
    ) == {
        "Modal-Key": "wk-test",
        "Modal-Secret": "ws-test",
        "Authorization": "Bearer api-key",
    }


def test_rejects_invalid_header_json_without_network_access():
    with pytest.raises(ModalPrimeError, match="valid JSON"):
        parse_inference_headers("not-json", None)
