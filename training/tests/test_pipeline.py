import json
from pathlib import Path
import pytest

from ama_training.provenance import digest, verify_dataset, jsonl
from ama_training.split import make_split, verify_split
from ama_training.train import build_blueprint
from ama_training.preflight import run_preflight
from ama_training.registry import load_registry, register_checkpoints
from ama_training.sample import assess, fixture_response, load_fixtures
from ama_training.export_adapter import resolve_checkpoint, artifact_manifest


def config_for(root, **overrides):
    return (
        build_blueprint("qwen3.5-4b")
        .apply(
            {
                "dataset_builder.file_path": str(root / "ama-traces-qwen.jsonl"),
                "dataset_builder.manifest_path": str(root / "prompt-manifest.json"),
                "dataset_builder.dataset_manifest_path": str(root / "dataset-manifest.json"),
                "dataset_builder.split_manifest_path": str(root / "split-manifest.json"),
                **overrides,
            }
        )
        .make()
    )


def test_export_lineage_and_tampering(verified_export):
    assert verify_dataset(verified_export / "dataset-manifest.json")["corpus_class"] == "synthetic"
    (verified_export / "source-traces.jsonl").write_text("changed")
    with pytest.raises(ValueError, match="changed"):
        verify_dataset(verified_export / "dataset-manifest.json")


def test_split_deterministic_preserves_families_and_frozen_assignments(verified_export):
    root = verified_export
    first = make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    second = make_split(root / "dataset-manifest.json", root / "other-split.json")
    assert first == second
    assert first["group_counts"] == {"train": 16, "selection": 2, "final": 2}
    extended = make_split(
        root / "dataset-manifest.json", root / "extended.json", root / "split-manifest.json"
    )
    assert first["assignments"] == extended["assignments"]
    rows = jsonl(root / "ama-traces-qwen.jsonl")
    verify_split(root / "split-manifest.json", first["dataset_sha256"], rows)
    rows[0]["family_ids"] = [
        next(
            f
            for f, p in first["family_assignments"].items()
            if p != first["assignments"][rows[0]["conversation_id"]]
        )
    ]
    with pytest.raises(ValueError, match="family partition"):
        verify_split(root / "split-manifest.json", first["dataset_sha256"], rows)


def test_all_row_preflight_and_actual_overrides(verified_export):
    root = verified_export
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    config = config_for(root)
    report = run_preflight(config)
    assert report["validated_rows"] == 20
    assert report["rendered_rows"] == 18
    assert report["counts"] == {"train": 16, "selection": 2, "final": 2}
    train, selection = config.dataset_builder()
    assert len(train.conversations) == 16 and len(selection.conversations) == 2
    assert report["min_target_tokens"] > 0
    with pytest.raises(ValueError, match="truncation forbidden"):
        run_preflight(config_for(root, **{"dataset_builder.common_config.max_length": 2}))
    with pytest.raises(ValueError, match="unverified"):
        run_preflight(config_for(root, **{"dataset_builder.allow_unverified_fixture": True}))


def test_registration_never_promotes_or_invents_sampler(verified_export, tmp_path):
    root = verified_export
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    preflight = run_preflight(config_for(root))
    logs = tmp_path / "logs"
    logs.mkdir()
    (logs / "checkpoints.jsonl").write_text(
        json.dumps(
            {
                "state_path": "tinker://r/weights/1",
                "sampler_path": "tinker://r/sampler_weights/1",
                "batch": 1,
            }
        )
        + "\n"
        + json.dumps({"state_path": "tinker://r/weights/2", "batch": 2})
        + "\n"
    )
    registry = tmp_path / "registry.json"
    ids = register_checkpoints("qwen3.5-4b", logs, preflight, None, registry)
    state = load_registry(registry)
    assert len(ids) == 1 and state["deployable"] == {}
    assert state["latest_training_state"]["qwen3.5-4b"]["state_path"].endswith("/2")
    with pytest.raises(ValueError, match="explicit"):
        resolve_checkpoint("qwen3.5-4b", None)


def test_smoke_tool_fixtures_and_assessments():
    fixtures = load_fixtures()["fixtures"]
    for fixture in fixtures:
        tool = fixture["expected_tool"]
        if tool:
            assert fixture["required_text"] in fixture_response(fixture, tool)
            with pytest.raises(ValueError, match="unexpected tool"):
                fixture_response(fixture, "wrong_tool")
        text = fixture.get("exact_text") or fixture.get("required_text") or "Hello!"
        assert assess(fixture, [tool] if tool else [], text, True)
        assert not assess(fixture, [tool] if tool else [], text, False)


def test_model_artifact_hashes_actual_files(tmp_path):
    (tmp_path / "model.safetensors").write_bytes(b"synthetic weights")
    manifest = artifact_manifest(
        tmp_path, "qwen3.5-4b", "tinker://r/sampler_weights/1", "candidate", True
    )
    assert manifest["format"] == "merged"
    assert "model.safetensors" in manifest["files"]


def test_smoke_runs_every_prompt_version_with_matching_tool_results(
    verified_export, tmp_path, monkeypatch
):
    import asyncio
    from types import SimpleNamespace
    from tinker_cookbook.renderers import ToolCall
    from tinker_cookbook.renderers.base import ParseTermination
    from ama_training import sample

    root = verified_export
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    config = config_for(root)
    preflight = run_preflight(config)
    selected = {
        "candidate_id": "test",
        "checkpoint_path": "tinker://r/sampler_weights/test",
        "training_config_sha256": preflight["training_config_sha256"],
        "dataset_sha256": preflight["dataset_sha256"],
        "preflight_sha256": preflight["artifact_sha256"],
    }
    monkeypatch.setattr(sample, "candidate", lambda *_: selected)
    queue = []
    for _version in ["v1", "v2"]:
        for fixture in load_fixtures()["fixtures"]:
            tool = fixture["expected_tool"]
            if tool:
                queue.append(
                    {
                        "role": "assistant",
                        "content": "",
                        "tool_calls": [
                            ToolCall.model_validate(
                                {
                                    "id": "call",
                                    "type": "function",
                                    "function": {"name": tool, "arguments": "{}"},
                                }
                            )
                        ],
                    }
                )
            queue.append(
                {
                    "role": "assistant",
                    "content": fixture.get("exact_text")
                    or fixture.get("required_text")
                    or "Hello!",
                }
            )

    class Client:
        async def sample_async(self, *args, **kwargs):
            return SimpleNamespace(sequences=[SimpleNamespace(tokens=[1])])

    monkeypatch.setattr(
        sample.tinker,
        "ServiceClient",
        lambda: SimpleNamespace(create_sampling_client=lambda **_: Client()),
    )
    monkeypatch.setattr(
        type(config.dataset_builder.renderer),
        "parse_response",
        lambda self, _: (queue.pop(0), ParseTermination.STOP_SEQUENCE),
    )
    report = asyncio.run(sample.run("test", config, tmp_path / "smoke.json", prompt_version="all"))
    assert len(report["results"]) == 12
    assert all(result["passed"] for result in report["results"])
    assert not queue


def test_canonical_hash_matches_javascript_numeric_and_unicode_edges():
    import subprocess

    module = (Path(__file__).resolve().parents[1] / "export" / "export-traces.mjs").as_uri()
    value = {
        "numbers": [1e-7, 1e-6, 1e21, 1.0, -0.0, 333333333.33333329],
        "keys": {"10": "ten", "2": "two", "\U0001f600": "emoji", "\ue000": "private-use"},
    }
    script = f"import {{digest}} from {json.dumps(module)}; console.log(digest(JSON.parse(process.argv[1])))"
    actual = subprocess.run(
        ["node", "--input-type=module", "-e", script, json.dumps(value)],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    assert digest(value) == actual
