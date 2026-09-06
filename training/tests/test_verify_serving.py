import io
import json
import pytest

from ama_training.provenance import digest, file_hash, seal, verify, write
from ama_training.serving_identity import (
    build_server_command,
    load_model_artifact,
    model_alias,
    server_alias,
    server_config,
)
from ama_training.verify_serving import CANARY, read_completion_stream, verify_serving

SETTINGS = {
    "call_settings": {"maxOutputTokens": 1024, "temperature": 0, "seed": 1, "maxRetries": 0}
}


def model_files(tmp_path):
    root = tmp_path / "model"
    root.mkdir()
    for name in ["config.json", "tokenizer_config.json", "model.safetensors"]:
        (root / name).write_text("fixture")
    artifact = seal(
        {
            "schema_version": 1,
            "kind": "ama_model_artifact",
            "candidate_id": "candidate",
            "checkpoint_path": "tinker://test/sampler_weights/10",
            "format": "merged",
            "files": {p.name: file_hash(p) for p in root.iterdir()},
        }
    )
    write(root / "artifact-manifest.json", artifact)
    template = tmp_path / "template.jinja"
    template.write_text("template")
    return root, template, artifact


def test_serving_command_uses_verified_identity_and_exact_parser_settings(tmp_path):
    root, template, artifact = model_files(tmp_path)
    command = build_server_command(root, template)
    assert model_alias(artifact) in command
    # vLLM reports the first served name in every completion, regardless of alias requested.
    assert command[command.index("--served-model-name") + 1] == model_alias(artifact)
    assert server_alias(server_config(artifact, template)) in command
    assert command[command.index("--tool-call-parser") + 1] == "qwen3_xml"
    assert command[command.index("--reasoning-parser") + 1] == "qwen3"
    assert json.loads(command[command.index("--default-chat-template-kwargs") + 1]) == {
        "enable_thinking": False
    }
    assert "--enable-force-include-usage" in command
    assert "--enable-auto-tool-choice" in command
    (root / "model.safetensors").write_text("changed weights")
    with pytest.raises(ValueError, match="artifact file changed"):
        build_server_command(root, template)


def sse(events, done=True):
    data = "".join("data: " + json.dumps(event) + "\r\n\r\n" for event in events)
    if done:
        data += "data: [DONE]\r\n\r\n"
    return io.BytesIO(data.encode())


@pytest.mark.parametrize(
    "first_text,final_text,expected",
    [
        ("", CANARY, True),
        ("", CANARY + "\ud800", False),
        ("<think>PRIVATE_REASONING</think>", CANARY, False),
    ],
)
def test_serving_requires_observed_identity_tool_grounding_and_complete_stream(
    tmp_path, first_text, final_text, expected
):
    root, template, artifact = model_files(tmp_path)
    alias = model_alias(artifact)
    calls = []

    def open_url(request, timeout):
        calls.append(request)
        if request.full_url.endswith("/models"):
            return io.BytesIO(
                json.dumps(
                    {
                        "data": [
                            {"id": alias},
                            {"id": server_alias(server_config(artifact, template))},
                        ]
                    }
                ).encode()
            )
        payload = json.loads(request.data)
        assert payload["max_tokens"] == 1024
        assert payload["model"] == alias
        if len(payload["messages"]) == 2:
            return sse(
                [
                    {
                        "model": alias,
                        "choices": [
                            {
                                "delta": {
                                    "content": first_text,
                                    "tool_calls": [
                                        {
                                            "index": 0,
                                            "id": "call",
                                            "function": {
                                                "name": "search_personal_context",
                                                "arguments": '{"query":',
                                            },
                                        }
                                    ],
                                }
                            }
                        ],
                    },
                    {
                        "choices": [
                            {
                                "delta": {
                                    "tool_calls": [
                                        {"index": 0, "function": {"arguments": '"architecture"}'}}
                                    ]
                                },
                                "finish_reason": "tool_calls",
                            }
                        ]
                    },
                    {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 10}},
                ]
            )
        assert CANARY in payload["messages"][-1]["content"]
        return sse(
            [
                {
                    "model": alias,
                    "choices": [{"delta": {"content": final_text}, "finish_reason": "stop"}],
                    "usage": {"prompt_tokens": 40, "completion_tokens": 10},
                }
            ]
        )

    result = verify_serving(
        model_dir=root,
        template=template,
        runtime_settings=SETTINGS,
        base_url="https://inference.example/v1",
        headers={"Authorization": "Bearer PRIVATE_TOKEN"},
        urlopen=open_url,
        parity_checker=lambda *_: {"passed": True},
        primer=lambda **_: 1,
    )
    assert result["passed"] is expected
    verify(result, "ama_serving_verification")
    assert result["serving_config_sha256"] == digest(result["config"])
    if expected:
        assert all(result["checks"].values())
        assert "failure_type" not in result
    assert len(calls) == 3
    assert "PRIVATE_TOKEN" not in json.dumps(result)
    assert CANARY not in json.dumps(result)


def test_template_failure_stops_before_any_model_request(tmp_path):
    root, template, _ = model_files(tmp_path)

    def forbidden(**_):
        raise AssertionError("must not call model")

    result = verify_serving(
        model_dir=root,
        template=template,
        runtime_settings=SETTINGS,
        base_url="https://inference.example/v1",
        headers={},
        primer=forbidden,
        parity_checker=lambda *_: {"passed": False},
    )
    assert not result["passed"]
    assert not any(result["checks"].values())


def test_identity_mismatch_stops_before_tool_calls(tmp_path):
    root, template, _ = model_files(tmp_path)
    urls = []

    def open_url(req, timeout):
        urls.append(req.full_url)
        return io.BytesIO(b'{"data":[{"id":"ama"}]}')

    result = verify_serving(
        model_dir=root,
        template=template,
        runtime_settings=SETTINGS,
        base_url="https://inference.example/v1",
        headers={},
        urlopen=open_url,
        primer=lambda **_: 1,
        parity_checker=lambda *_: {"passed": True},
    )
    assert not result["passed"]
    assert not result["checks"]["artifact_identity"]
    assert urls == ["https://inference.example/v1/models"]


@pytest.mark.parametrize("mutation", ["changed", "extra", "missing"])
def test_model_identity_rejects_modified_or_unlisted_files(tmp_path, mutation):
    root, _, _ = model_files(tmp_path)
    if mutation == "changed":
        (root / "model.safetensors").write_text("changed")
    elif mutation == "extra":
        (root / "extra.safetensors").write_text("new shard")
    else:
        (root / "model.safetensors").unlink()
    with pytest.raises(ValueError):
        load_model_artifact(root)


@pytest.mark.parametrize(
    "events,done",
    [
        ([{"choices": [{"delta": {"content": "partial"}}]}], False),
        ([{"choices": [{"delta": {"content": "partial"}}]}], True),
        ([{"error": "PRIVATE_PROVIDER_FAILURE"}], True),
        (
            [{"choices": [{"delta": {"reasoning_content": "private"}, "finish_reason": "stop"}]}],
            True,
        ),
    ],
)
def test_incomplete_or_unsafe_provider_stream_cannot_pass(events, done):
    with pytest.raises(ValueError):
        read_completion_stream(sse(events, done))


@pytest.mark.parametrize(
    "usage",
    [
        None,
        {},
        {"prompt_tokens": 1},
        {"prompt_tokens": True, "completion_tokens": 1},
        {"prompt_tokens": -1, "completion_tokens": 1},
    ],
)
def test_serving_rejects_missing_or_invalid_token_usage(usage):
    with pytest.raises(ValueError, match="token usage"):
        read_completion_stream(
            sse(
                [
                    {
                        "choices": [{"delta": {"content": "answer"}, "finish_reason": "stop"}],
                        "usage": usage,
                    }
                ]
            )
        )


def test_serving_rejects_content_after_finish():
    with pytest.raises(ValueError, match="after its finish"):
        read_completion_stream(
            sse(
                [
                    {"choices": [{"delta": {"content": "answer"}, "finish_reason": "stop"}]},
                    {"choices": [{"delta": {"content": "late content"}}]},
                ]
            )
        )
