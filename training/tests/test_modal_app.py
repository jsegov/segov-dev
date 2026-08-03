"""Modal deployment readiness tests.

The repository's uv environment intentionally excludes Modal because the CLI
is installed separately. These tests run in deployment-capable environments
and skip cleanly in the training-only environment.
"""

import pytest

pytest.importorskip("modal")

from deploy import modal_app


def test_disables_only_cross_rank_nccl_dump_polling():
    assert modal_app.VLLM_ENV["TORCH_NCCL_DUMP_ON_TIMEOUT"] == "0"
    assert modal_app.VLLM_ENV.get("TORCH_NCCL_ENABLE_MONITORING", "1") == "1"


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"is_sleeping": False}, False),
        ({"is_sleeping": True}, True),
        (False, False),
        (True, True),
    ],
)
def test_parses_vllm_sleep_state(payload, expected):
    assert modal_app._is_vllm_sleeping(payload) is expected


@pytest.mark.parametrize(
    "payload",
    [None, {}, {"sleeping": False}, {"is_sleeping": "false"}],
)
def test_rejects_ambiguous_vllm_sleep_state(payload):
    with pytest.raises(ValueError, match="invalid response"):
        modal_app._is_vllm_sleeping(payload)


class RunningProcess:
    args = ["vllm", "serve"]

    def poll(self):
        return None


class HealthyResponse:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None


def test_readiness_advances_from_awake_state_to_health_and_generation(monkeypatch):
    completion_calls = []
    monkeypatch.setattr(
        modal_app, "_get_json", lambda path, timeout: {"is_sleeping": False}
    )
    monkeypatch.setattr(
        modal_app.urllib.request,
        "urlopen",
        lambda url, timeout: HealthyResponse(),
    )
    monkeypatch.setattr(
        modal_app,
        "_post",
        lambda path, payload, timeout: completion_calls.append(
            {"path": path, "payload": payload, "timeout": timeout}
        ),
    )

    modal_app._wait_for_serving_ready(RunningProcess(), timeout_s=1)

    assert completion_calls == [
        {
            "path": "/v1/chat/completions",
            "payload": {
                "model": "ama",
                "messages": [{"role": "user", "content": "readiness"}],
                "max_tokens": 1,
                "temperature": 0,
                "seed": 1,
            },
            "timeout": 30,
        }
    ]


def test_readiness_rejects_a_malformed_sleep_state_immediately(monkeypatch):
    monkeypatch.setattr(modal_app, "_get_json", lambda path, timeout: {})

    with pytest.raises(ValueError, match="invalid response"):
        modal_app._wait_for_serving_ready(RunningProcess(), timeout_s=1)
