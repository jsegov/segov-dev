"""Split-planner regressions using synthetic rows, without dataset acquisition."""

import copy
import json

import pytest

from ama_training import split
from ama_training.provenance import digest, seal, write


def rows(count, prefix="conversation"):
    return [
        {"conversation_id": f"{prefix}-{index}", "family_ids": [f"{prefix}-family-{index}"]}
        for index in range(count)
    ]


@pytest.fixture
def make_dataset(tmp_path, monkeypatch):
    # Full provenance integration is covered by test_pipeline. Isolate split
    # planning here so later synthetic snapshots can vary group membership.
    monkeypatch.setattr(split, "verify_dataset", lambda path: json.loads(path.read_text()))

    def make(name, examples):
        root = tmp_path / name
        root.mkdir()
        manifest = root / "dataset-manifest.json"
        manifest.write_text(json.dumps({"artifact_sha256": digest(examples)}))
        (root / "ama-traces-qwen.jsonl").write_text(
            "".join(json.dumps(row) + "\n" for row in examples)
        )
        return manifest, root / "split.json"

    return make


def changed_manifest(path, value, **updates):
    payload = {key: copy.deepcopy(item) for key, item in value.items() if key != "artifact_sha256"}
    payload.update(updates)
    return write(path, seal(payload))


def test_chain_retains_absent_and_reappearing_conversations_and_families(make_dataset):
    initial_rows = rows(20)
    initial_dataset, initial_path = make_dataset("initial", initial_rows)
    initial = split.make_split(initial_dataset, initial_path)
    assert initial["group_counts"] == {"train": 16, "selection": 2, "final": 2}

    missing = next(
        row for row in initial_rows if initial["assignments"][row["conversation_id"]] == "train"
    )
    second_rows = [row for row in initial_rows if row != missing] + rows(1, "new")
    second_dataset, second_path = make_dataset("second", second_rows)
    second = split.make_split(second_dataset, second_path, initial_path)
    assert second["assignments"][missing["conversation_id"]] == "train"
    assert second["family_assignments"][missing["family_ids"][0]] == "train"
    assert second["parent_split_sha256"] == initial["artifact_sha256"]

    third_rows = [*second_rows, missing, {**missing, "conversation_id": "related-return"}]
    third_dataset, third_path = make_dataset("third", third_rows)
    third = split.make_split(third_dataset, third_path, second_path)
    assert third["assignments"]["related-return"] == "train"
    assert all(
        third["assignments"][cid] == partition for cid, partition in initial["assignments"].items()
    )
    split.verify_split(third_path, third["dataset_sha256"], third_rows)


@pytest.mark.parametrize("field", ["assignments", "family_assignments"])
@pytest.mark.parametrize("invalid", ["unknown", None, ["train"]])
def test_rejects_invalid_historical_values_even_when_absent_from_current_rows(
    make_dataset, field, invalid
):
    dataset, output = make_dataset("initial", rows(20))
    initial = split.make_split(dataset, output)
    values = {**initial[field], "absent-historical-identity": invalid}
    changed_manifest(output, initial, **{field: values})
    new_output = output.with_name("invalid.json")
    with pytest.raises(ValueError, match="invalid persisted"):
        split.make_split(dataset, new_output, output)
    assert not new_output.exists()
    with pytest.raises(ValueError, match="invalid persisted"):
        split.verify_split(output, initial["dataset_sha256"], rows(20))


def test_rejects_snapshot_missing_frozen_partitions_before_writing(make_dataset):
    initial_rows = rows(20)
    dataset, output = make_dataset("initial", initial_rows)
    initial = split.make_split(dataset, output)
    train_only = [
        row for row in initial_rows if initial["assignments"][row["conversation_id"]] == "train"
    ]
    new_dataset, new_output = make_dataset("train-only", train_only)
    with pytest.raises(ValueError, match="nonempty"):
        split.make_split(new_dataset, new_output, output)
    assert not new_output.exists()
    with pytest.raises(ValueError, match="nonempty"):
        split.verify_split(output, initial["dataset_sha256"], train_only)
    with pytest.raises(ValueError, match="nonempty"):
        split.verify_split(output, initial["dataset_sha256"], [])


def test_new_groups_fill_empty_partitions_without_moving_frozen_assignments(make_dataset):
    initial_rows = rows(100)
    dataset, output = make_dataset("initial", initial_rows)
    initial = split.make_split(dataset, output)
    selection_rows = [
        row for row in initial_rows if initial["assignments"][row["conversation_id"]] == "selection"
    ]
    next_rows = [*selection_rows, *rows(2, "new")]
    next_dataset, next_output = make_dataset("selection-heavy", next_rows)
    result = split.make_split(next_dataset, next_output, output)
    assert result["group_counts"] == {"selection": 10, "train": 1, "final": 1}
    assert all(
        result["assignments"][cid] == partition for cid, partition in initial["assignments"].items()
    )
    split.verify_split(next_output, result["dataset_sha256"], next_rows)


def test_rejects_cross_partition_family_bridge(make_dataset):
    initial_rows = rows(20)
    dataset, output = make_dataset("initial", initial_rows)
    initial = split.make_split(dataset, output)
    train = next(
        row for row in initial_rows if initial["assignments"][row["conversation_id"]] == "train"
    )
    selection = next(
        row for row in initial_rows if initial["assignments"][row["conversation_id"]] == "selection"
    )
    next_rows = copy.deepcopy(initial_rows)
    for row in next_rows:
        if row["conversation_id"] in {train["conversation_id"], selection["conversation_id"]}:
            row["family_ids"].append("new-cross-partition-bridge")
    next_dataset, next_output = make_dataset("overlapping", next_rows)
    with pytest.raises(ValueError, match="crosses frozen partitions"):
        split.make_split(next_dataset, next_output, output)
    assert not next_output.exists()


@pytest.mark.parametrize("counts", [{"train": 20}, {"train": 18, "selection": 1, "final": 0}])
def test_rejects_empty_persisted_partition_counts(make_dataset, counts):
    dataset, output = make_dataset("initial", rows(20))
    initial = split.make_split(dataset, output)
    changed_manifest(output, initial, group_counts=counts)
    with pytest.raises(ValueError, match="nonempty"):
        split.make_split(dataset, output.with_name("invalid.json"), output)
    with pytest.raises(ValueError, match="nonempty"):
        split.verify_split(output, initial["dataset_sha256"], rows(20))
