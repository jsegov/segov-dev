"""Offline CLI contracts: explicit prompt selection and full validation with previews."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ama_training import sample, validate


def smoke_setup(monkeypatch, versions=("v1", "v2")):
    preflight = {
        "artifact_sha256": "preflight",
        "training_config_sha256": "config",
        "dataset_sha256": "dataset",
        "prompt_versions": list(versions),
    }
    selected = {
        "checkpoint_path": "tinker://synthetic/candidate",
        "preflight_sha256": "preflight",
        "training_config_sha256": "config",
        "dataset_sha256": "dataset",
    }
    manifest = {
        version: SimpleNamespace(tools=[], system_prompt=f"PRIVATE_SYSTEM_{version}")
        for version in versions
    }
    monkeypatch.setattr(sample, "candidate", lambda _: selected)
    monkeypatch.setattr(sample, "run_preflight", lambda _: preflight)
    monkeypatch.setattr(sample, "load_manifest", lambda _: manifest)
    monkeypatch.setattr(
        sample,
        "load_fixtures",
        lambda: {
            "fixtures": [
                {
                    "id": "synthetic",
                    "question": "PRIVATE_QUESTION",
                    "expected_tool": None,
                    "tool_results": {},
                    "required_text": "safe",
                }
            ]
        },
    )
    prompts = []

    def generation_prompt(conversation, **_):
        prompts.append(conversation)
        return SimpleNamespace()

    renderer = SimpleNamespace(
        create_conversation_prefix_with_tools=lambda tools, system: [
            {"role": "system", "content": system}
        ],
        build_generation_prompt=generation_prompt,
        get_stop_sequences=lambda: ["stop"],
        parse_response=lambda _: (
            {"role": "assistant", "content": "A safe answer."},
            SimpleNamespace(is_clean=True),
        ),
    )
    config = SimpleNamespace(
        dataset_builder=SimpleNamespace(
            manifest_path="captured.json", renderer=renderer, effort=None
        )
    )

    class Client:
        async def sample_async(self, *_args, **_kwargs):
            return SimpleNamespace(sequences=[SimpleNamespace(tokens=[1])])

    service = Mock(return_value=SimpleNamespace(create_sampling_client=lambda **_: Client()))
    monkeypatch.setattr(sample.tinker, "ServiceClient", service)
    return config, service, prompts


@pytest.mark.parametrize(
    "selector,error",
    [
        (None, "multiple prompt versions"),
        ("missing", "unknown prompt_version"),
        ("", "must name"),
    ],
)
def test_sample_rejects_invalid_selection_before_tinker(monkeypatch, tmp_path, selector, error):
    config, service, _ = smoke_setup(monkeypatch)
    output = tmp_path / "smoke.json"
    with pytest.raises(ValueError, match=error):
        asyncio.run(sample.run("candidate", config, output, prompt_version=selector))
    service.assert_not_called()
    assert not output.exists()


@pytest.mark.parametrize("selector,expected", [("v1", ["v1"]), ("all", ["v1", "v2"])])
def test_sample_runs_only_the_explicit_selection(monkeypatch, tmp_path, selector, expected):
    config, service, prompts = smoke_setup(monkeypatch)
    output = tmp_path / "smoke.json"
    report = asyncio.run(sample.run("candidate", config, output, prompt_version=selector))
    assert report["prompt_versions"] == expected
    assert report["prompt_version_selection"] == selector
    assert [row["prompt_version"] for row in report["results"]] == expected
    assert len(prompts) == len(expected)
    service.assert_called_once()
    assert "PRIVATE_" not in output.read_text()


def test_sample_infers_only_a_single_manifest_version(monkeypatch, tmp_path):
    config, service, _ = smoke_setup(monkeypatch, ("v1",))
    report = asyncio.run(sample.run("candidate", config, tmp_path / "smoke.json"))
    assert report["prompt_versions"] == ["v1"]
    service.assert_called_once()


def test_manifest_ambiguity_is_explicit_even_if_candidate_uses_only_one_version():
    manifest = {"v1": object(), "v2": object()}
    with pytest.raises(ValueError, match="multiple prompt versions"):
        sample.select_prompt_versions(manifest, ["v1"])
    with pytest.raises(ValueError, match="candidate's training preflight"):
        sample.select_prompt_versions(manifest, ["v1"], "v2")
    assert list(sample.select_prompt_versions(manifest, ["v1"], "all")) == ["v1"]


def test_sample_cli_separates_prompt_selection_from_training_overrides(monkeypatch):
    config = object()
    resolve = Mock(return_value=("preset", config))
    calls = []

    async def run(*args, **kwargs):
        calls.append((args, kwargs))

    monkeypatch.setattr(sample, "resolve_config", resolve)
    monkeypatch.setattr(sample, "run", run)
    sample.main(["candidate=id", "output=report.json", "prompt_version=all", "preset=qwen3.5-4b"])
    resolve.assert_called_once_with(["preset=qwen3.5-4b"])
    assert calls == [(("id", config, "report.json"), {"prompt_version": "all"})]


def validation_setup(monkeypatch, invalid_last=False):
    rows = [
        (
            {"system_prompt_version": "v1", "messages": [{"content": f"PRIVATE_MESSAGE_{i}"}]},
            "final" if i == 0 else "selection" if i == 1 else "train",
            [{"role": "user", "content": f"PRIVATE_MESSAGE_{i}"}],
        )
        for i in range(6)
    ]
    preview_read = Mock(return_value=rows)
    builder = SimpleNamespace(conversations_with_metadata=preview_read)
    config = SimpleNamespace(dataset_builder=builder)
    resolve = Mock(return_value=("preset", config))
    checked = []
    report = {
        "validated_rows": 6,
        "rendered_rows": 5,
        "counts": {"train": 4, "selection": 1, "final": 1},
        "max_tokens": 17,
        "artifact_sha256": "a" * 64,
    }

    def preflight(actual_config, output):
        assert actual_config is config
        for index, _ in enumerate(rows):
            checked.append(index)
            if invalid_last and index == len(rows) - 1:
                raise ValueError("invalid final row in full preflight")
        if output:
            Path(output).write_text(json.dumps(report))
        return report

    monkeypatch.setattr(validate, "resolve_config", resolve)
    monkeypatch.setattr(validate, "run_preflight", preflight)
    return resolve, preview_read, checked, report


def test_preview_limit_does_not_reduce_full_validation_or_saved_evidence(
    monkeypatch, tmp_path, capsys
):
    resolve, preview_read, checked, expected = validation_setup(monkeypatch)
    output = tmp_path / "preflight.json"
    report = validate.main(["preset=qwen3.5-4b", "limit=1", f"output={output}"])
    assert checked == list(range(6))
    assert report == expected == json.loads(output.read_text())
    resolve.assert_called_once_with(["preset=qwen3.5-4b"])
    preview_read.assert_called_once()
    stdout = capsys.readouterr().out
    previews = [
        json.loads(line.removeprefix("Preview: "))
        for line in stdout.splitlines()
        if line.startswith("Preview: ")
    ]
    assert len(previews) == 1 and previews[0]["partition"] == "selection"
    assert "PRIVATE_MESSAGE" not in stdout
    assert "Validated 6 rows" in stdout


def test_validation_rejects_errors_beyond_the_preview_limit(monkeypatch, capsys):
    _, preview_read, checked, _ = validation_setup(monkeypatch, invalid_last=True)
    with pytest.raises(ValueError, match="invalid final row"):
        validate.main(["limit=1"])
    assert checked == list(range(6))
    preview_read.assert_not_called()
    assert "Preview:" not in capsys.readouterr().out


def test_validation_default_prints_no_example_text_or_preview(monkeypatch, capsys):
    _, preview_read, checked, _ = validation_setup(monkeypatch)
    validate.main([])
    assert checked == list(range(6))
    preview_read.assert_not_called()
    stdout = capsys.readouterr().out
    assert "Preview:" not in stdout and "PRIVATE_MESSAGE" not in stdout


@pytest.mark.parametrize("value", ["-1", "101", "1.5", "NaN", "", "1e2"])
def test_invalid_preview_limit_fails_before_config_or_preflight(monkeypatch, value):
    resolve = Mock()
    preflight = Mock()
    monkeypatch.setattr(validate, "resolve_config", resolve)
    monkeypatch.setattr(validate, "run_preflight", preflight)
    with pytest.raises(ValueError, match="limit must be an integer"):
        validate.main([f"limit={value}"])
    resolve.assert_not_called()
    preflight.assert_not_called()


def test_preview_limit_bounds_and_duplicate_options():
    assert validate.parse_preview_limit("0") == 0
    assert validate.parse_preview_limit("100") == 100
    with pytest.raises(ValueError, match="duplicate limit"):
        validate.main(["limit=1", "limit=2"])
    with pytest.raises(ValueError, match="duplicate prompt_version"):
        sample.main(
            ["candidate=id", "output=report.json", "prompt_version=v1", "prompt_version=all"]
        )
