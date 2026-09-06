"""Dynamic tool availability must fail closed before any training rendering."""

import json

import pytest

from ama_training.manifest import load_manifest
from ama_training.preflight import run_preflight
from ama_training.provenance import file_hash, seal, verify_dataset, write
from ama_training.split import make_split
from test_pipeline import config_for


def reseal_dataset(root):
    """Keep every hash/review valid, so tests exercise policy rather than tampering."""
    snapshot = json.loads((root / "snapshot-manifest.json").read_text())
    snapshot.pop("artifact_sha256")
    snapshot["files"]["prompt-manifest.json"] = file_hash(root / "source-prompts.json")
    snapshot = seal(snapshot)
    write(root / "snapshot-manifest.json", snapshot)
    reviews = json.loads((root / "reviews.json").read_text())
    reviews["snapshot_sha256"] = snapshot["artifact_sha256"]
    write(root / "reviews.json", reviews)
    dataset = json.loads((root / "dataset-manifest.json").read_text())
    dataset.pop("artifact_sha256")
    dataset["snapshot_sha256"] = snapshot["artifact_sha256"]
    dataset["files"] = {name: file_hash(root / name) for name in dataset["files"]}
    write(root / "dataset-manifest.json", seal(dataset))


@pytest.mark.parametrize("policy", ["single-use-context-v1", "unknown", "static", None, "", False])
@pytest.mark.parametrize("location", ["source_envelope", "derived_envelope", "derived_metadata"])
def test_preflight_rejects_approved_policy_even_with_valid_lineage(
    verified_export, policy, location, monkeypatch
):
    root = verified_export
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    name = "source-prompts.json" if location == "source_envelope" else "prompt-manifest.json"
    prompts = json.loads((root / name).read_text())
    target = prompts["v1"] if location == "derived_metadata" else prompts["v1"]["call_settings"]
    target["toolAvailabilityPolicy"] = policy
    write(root / name, prompts)
    reseal_dataset(root)
    config = config_for(root)

    def must_not_render(*args, **kwargs):
        pytest.fail("unsupported tool policy reached conversation rendering")

    monkeypatch.setattr(type(config.dataset_builder), "conversations_with_metadata", must_not_render)
    with pytest.raises(ValueError, match="unsupported tool availability policy.*v1"):
        run_preflight(config)


def test_unused_dynamic_versions_do_not_reject_static_examples(verified_export):
    root = verified_export
    for name in ("source-prompts.json", "prompt-manifest.json"):
        prompts = json.loads((root / name).read_text())
        prompts["unused-dynamic"] = {
            **prompts["v1"],
            "version": "unused-dynamic",
            "toolAvailabilityPolicy": "single-use-context-v1",
        }
        write(root / name, prompts)
    reseal_dataset(root)
    verify_dataset(root / "dataset-manifest.json")
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    report = run_preflight(config_for(root))
    assert report["prompt_versions"] == ["v1", "v2"]
    assert report["validated_rows"] == 20
    assert load_manifest(root / "prompt-manifest.json")["unused-dynamic"].tool_availability_policy_present


def test_fixture_bypass_still_rejects_policy_before_renderer(verified_export, monkeypatch):
    root = verified_export
    prompts = json.loads((root / "prompt-manifest.json").read_text())
    prompts["v1"]["toolAvailabilityPolicy"] = "single-use-context-v1"
    write(root / "prompt-manifest.json", prompts)
    builder = config_for(root, **{"dataset_builder.allow_unverified_fixture": True}).dataset_builder
    row = {"system_prompt_version": "v1", "messages": []}
    monkeypatch.setattr(type(builder), "records", lambda self: [(row, "train")])
    with pytest.raises(ValueError, match="unsupported tool availability policy.*v1"):
        builder.conversations_with_metadata()
