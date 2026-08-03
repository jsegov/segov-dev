"""Prime and validate the deployed scale-to-zero Modal inference server.

Run this after every ``modal deploy``. Modal intentionally returns HTTP 503
while assigning or restoring a container, so this probe retries that startup
state (and client timeouts) for up to ten minutes. It only succeeds after the
OpenAI-compatible endpoint generates a non-empty completion.

The script uses the same environment variables as the Next.js chat route and
never prints credentials::

    AMA_INFERENCE_BASE_URL=https://...modal.direct/v1 \
    AMA_INFERENCE_HEADERS='{"Modal-Key":"wk-...","Modal-Secret":"ws-..."}' \
    AMA_DEPLOYMENT_MODEL=ama \
    python deploy/prime_modal.py
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from typing import Any

DEFAULT_TIMEOUT_SECONDS = 10 * 60
DEFAULT_REQUEST_TIMEOUT_SECONDS = 15
DEFAULT_RETRY_DELAY_SECONDS = 2


class ModalPrimeError(RuntimeError):
    """The deployed endpoint could not be safely primed."""


def parse_inference_headers(raw_headers: str | None, api_key: str | None) -> dict[str, str]:
    """Parse proxy/Bearer auth without exposing the values in diagnostics."""
    headers: dict[str, str] = {}
    if raw_headers:
        try:
            parsed = json.loads(raw_headers)
        except json.JSONDecodeError as error:
            raise ModalPrimeError("AMA_INFERENCE_HEADERS must be valid JSON") from error
        if not isinstance(parsed, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in parsed.items()
        ):
            raise ModalPrimeError("AMA_INFERENCE_HEADERS must be a JSON object of strings")
        headers.update(parsed)

    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _completion_content(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return ""
    message = choices[0].get("message")
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    return content.strip() if isinstance(content, str) else ""


def _is_timeout(error: BaseException) -> bool:
    if isinstance(error, (TimeoutError, socket.timeout)):
        return True
    return isinstance(error, urllib.error.URLError) and isinstance(
        error.reason, (TimeoutError, socket.timeout)
    )


def prime_modal_endpoint(
    *,
    base_url: str,
    model: str,
    headers: Mapping[str, str],
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
    request_timeout_seconds: float = DEFAULT_REQUEST_TIMEOUT_SECONDS,
    retry_delay_seconds: float = DEFAULT_RETRY_DELAY_SECONDS,
    urlopen: Callable[..., Any] = urllib.request.urlopen,
    monotonic: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    """Retry Modal's startup states until a real completion succeeds.

    Returns the number of HTTP attempts. HTTP 503 and client-side timeouts are
    retryable because both can occur while a scale-to-zero worker is starting.
    Authentication, configuration, and other HTTP/network failures stop
    immediately so a bad deployment cannot masquerade as a long cold start.
    """
    if timeout_seconds <= 0:
        raise ModalPrimeError("timeout_seconds must be greater than zero")
    if request_timeout_seconds <= 0:
        raise ModalPrimeError("request_timeout_seconds must be greater than zero")

    endpoint = f"{base_url.rstrip('/')}/chat/completions"
    body = json.dumps(
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "Reply with exactly READY.",
                }
            ],
            "max_tokens": 8,
            "temperature": 0,
            "seed": 1,
            "stream": False,
        }
    ).encode()
    request = urllib.request.Request(
        endpoint,
        data=body,
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )

    started_at = monotonic()
    deadline = started_at + timeout_seconds
    attempts = 0
    last_startup_error: BaseException | None = None

    while (remaining := deadline - monotonic()) > 0:
        attempts += 1
        try:
            with urlopen(request, timeout=min(request_timeout_seconds, remaining)) as response:
                if response.status != 200:
                    if response.status == 503:
                        raise urllib.error.HTTPError(
                            endpoint, response.status, "warming", response.headers, None
                        )
                    raise ModalPrimeError(f"inference endpoint returned HTTP {response.status}")
                try:
                    payload = json.load(response)
                except json.JSONDecodeError as error:
                    raise ModalPrimeError(
                        "inference endpoint returned invalid JSON"
                    ) from error
            if not _completion_content(payload):
                raise ModalPrimeError(
                    "inference endpoint returned HTTP 200 without a non-empty completion"
                )
            return attempts
        except urllib.error.HTTPError as error:
            if error.code != 503:
                raise ModalPrimeError(
                    f"inference endpoint returned terminal HTTP {error.code}"
                ) from error
            last_startup_error = error
        except (TimeoutError, socket.timeout, urllib.error.URLError) as error:
            if not _is_timeout(error):
                raise ModalPrimeError("inference endpoint network request failed") from error
            last_startup_error = error

        remaining = deadline - monotonic()
        if remaining > 0:
            sleep(min(max(retry_delay_seconds, 0), remaining))

    elapsed = monotonic() - started_at
    raise ModalPrimeError(
        f"inference endpoint did not become ready within {elapsed:.1f}s "
        f"after {attempts} attempts"
    ) from last_startup_error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prime a deployed Modal vLLM server and verify a real completion."
    )
    parser.add_argument("--base-url", default=os.environ.get("AMA_INFERENCE_BASE_URL"))
    parser.add_argument(
        "--model", default=os.environ.get("AMA_DEPLOYMENT_MODEL", "ama")
    )
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument(
        "--request-timeout", type=float, default=DEFAULT_REQUEST_TIMEOUT_SECONDS
    )
    parser.add_argument(
        "--retry-delay", type=float, default=DEFAULT_RETRY_DELAY_SECONDS
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.base_url:
        raise ModalPrimeError("set AMA_INFERENCE_BASE_URL or pass --base-url")

    headers = parse_inference_headers(
        os.environ.get("AMA_INFERENCE_HEADERS"),
        os.environ.get("AMA_INFERENCE_API_KEY"),
    )
    print(
        f"Priming {args.model} at {args.base_url} "
        f"(startup budget: {args.timeout:.0f}s)..."
    )
    attempts = prime_modal_endpoint(
        base_url=args.base_url,
        model=args.model,
        headers=headers,
        timeout_seconds=args.timeout,
        request_timeout_seconds=args.request_timeout,
        retry_delay_seconds=args.retry_delay,
    )
    print(f"Modal inference is serving completions after {attempts} attempt(s).")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ModalPrimeError as error:
        print(f"Modal primer failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
