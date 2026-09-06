"""Synthetic parity checks; only a previously cached tokenizer is allowed."""

import hashlib
from pathlib import Path

import pytest

from ama_training.template_parity import _first_token_mismatch, check_template_parity


TEMPLATE = Path(__file__).parents[1] / "deploy" / "chat_template_parity.jinja"


@pytest.fixture(scope="module")
def tokenizer():
    from huggingface_hub import snapshot_download
    from huggingface_hub.errors import LocalEntryNotFoundError
    from transformers import AutoTokenizer

    try:
        cached = snapshot_download("Qwen/Qwen3.5-4B", local_files_only=True)
    except LocalEntryNotFoundError:
        pytest.fail(
            "Required Qwen3.5 tokenizer is unavailable. Run the documented tokenizer setup before offline tests.",
            pytrace=False,
        )
    # Resolve the local path first: some Transformers versions inspect remote
    # model metadata despite local_files_only=True when passed a model ID.
    return AutoTokenizer.from_pretrained(cached, local_files_only=True)


def test_reports_exact_token_mismatch_even_when_rendered_bytes_match(tokenizer):
    report = check_template_parity(TEMPLATE, tokenizer)
    by_id = {case["id"]: case for case in report["cases"]}
    assert set(by_id) == {
        "single_user",
        "tool_schema",
        "tool_response",
        "tool_response_with_text",
        "parallel_tools_nested_arguments",
        "multiturn_tool_history",
    }
    assert by_id["single_user"]["token_equal"]
    assert by_id["tool_schema"]["token_equal"]
    # Nested Unicode argument values now use the same ASCII escaping as
    # training, so every fixture matches bytes even when token boundaries differ.
    assert all(case["byte_equal"] for case in report["cases"])
    # Chunked training encodes adjacent newline chunks separately. The current
    # serving template produces identical bytes but merges them into another BPE
    # token; the release gate must retain this failure rather than normalize it.
    tool_case = by_id["tool_response"]
    assert tool_case["byte_equal"]
    assert not tool_case["token_equal"]
    mismatch = tool_case["first_token_mismatch"]
    assert mismatch["training_token"] != mismatch["serving_token"]
    assert report["passed"] is False
    assert report["template_sha256"] == hashlib.sha256(TEMPLATE.read_bytes()).hexdigest()
    assert len(report["fixture_sha256"]) == 64
    assert report == check_template_parity(TEMPLATE, tokenizer)


def test_modified_template_fails_and_is_bound_to_report(tokenizer, tmp_path):
    changed = tmp_path / "changed.jinja"
    changed.write_text(TEMPLATE.read_text() + "\nSYNTHETIC_TEMPLATE_DRIFT", encoding="utf-8")
    report = check_template_parity(changed, tokenizer)
    assert not report["passed"]
    assert all(not case["byte_equal"] for case in report["cases"])
    assert report["template_sha256"] == hashlib.sha256(changed.read_bytes()).hexdigest()
    assert report["template_sha256"] != hashlib.sha256(TEMPLATE.read_bytes()).hexdigest()


@pytest.mark.parametrize(
    "training,serving,expected",
    [
        ([1, 2], [1, 2], None),
        ([1, 2], [1, 3], {"index": 1, "training_token": 2, "serving_token": 3}),
        ([1, 2], [1], {"index": 1, "training_token": 2, "serving_token": None}),
        ([1], [1, 2], {"index": 1, "training_token": None, "serving_token": 2}),
    ],
)
def test_first_mismatch_includes_length_differences(training, serving, expected):
    assert _first_token_mismatch(training, serving) == expected
