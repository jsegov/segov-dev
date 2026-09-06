"""Validate every row structurally; render train/selection with the actual shifted datum.

Frozen final targets are not rendered or summarized before the winner is locked.
"""
from collections import Counter
from importlib.metadata import version
import math
import json
from pathlib import Path

import chz

from ama_training.provenance import digest, file_hash, read, seal, verify_dataset, write


def training_config(config):
    """Semantic config: includes every resolved recipe field, excluding output location."""
    value = chz.asdict(config)
    value.pop("log_path", None)
    # Paths locate artifacts; content hashes identify them across machines.
    builder = value["dataset_builder"]
    for key in ["file_path", "manifest_path", "dataset_manifest_path", "split_manifest_path"]:
        if builder.get(key):
            builder[key] = Path(builder[key]).name
    return value


def run_preflight(config, output=None):
    builder = config.dataset_builder
    if builder.allow_unverified_fixture:
        raise ValueError("unverified fixtures cannot pass training preflight")
    if (
        config.model_name != builder.common_config.model_name_for_tokenizer
        or config.renderer_name != builder.common_config.renderer_name
    ):
        raise ValueError("training model/renderer and tokenizer configuration differ")
    if (
        builder.common_config.max_length is None
        or builder.common_config.max_length < 2
        or builder.common_config.batch_size < 1
    ):
        raise ValueError("explicit positive batch size and bounded max_length required")
    dataset = verify_dataset(builder.dataset_manifest_path)
    split = read(builder.split_manifest_path, "ama_split")
    evaluation_fingerprints = json.loads(
        (Path(builder.dataset_manifest_path).parent / "evaluation-fingerprints.json").read_text()
    )
    counts, lengths, target_counts = Counter(), [], []
    prompt_versions = set()
    for row, partition, conversation in builder.conversations_with_metadata():
        prompt_versions.add(row["system_prompt_version"])
        counts[partition] += 1
        if partition == "final":
            continue
        model_input, weights = builder.render(conversation)
        if model_input.length > builder.common_config.max_length:
            raise ValueError(
                f"example {row['conversation_id']} exceeds max_length; truncation forbidden"
            )
        if len(weights) != model_input.length:
            raise ValueError("renderer input/weight lengths differ")
        datum = builder.to_datum(conversation)
        actual = datum.loss_fn_inputs["weights"].data
        if (
            not actual
            or any(not math.isfinite(float(w)) or w < 0 for w in actual)
            or sum(actual) <= 0
        ):
            raise ValueError("actual shifted training datum has no finite positive targets")
        lengths.append(model_input.length)
        target_counts.append(sum(w > 0 for w in actual))
    if any(counts[p] == 0 for p in ("train", "selection", "final")):
        raise ValueError("all three partitions must have examples in the selected construction")
    resolved = training_config(config)
    artifact = seal(
        {
            "schema_version": 1,
            "kind": "ama_preflight",
            "dataset_sha256": dataset["artifact_sha256"],
            "split_sha256": split["artifact_sha256"],
            "split_manifest": split,
            "evaluation_datasets": {
                key: evaluation_fingerprints[key]
                for key in ("selection_dataset_sha256", "final_dataset_sha256")
            },
            "training_config": resolved,
            "training_config_sha256": digest(resolved),
            "source_sha256": {
                name: file_hash(Path(__file__).parent / name)
                for name in (
                    "dataset.py",
                    "manifest.py",
                    "preflight.py",
                    "split.py",
                    "provenance.py",
                )
            },
            "lockfile_sha256": file_hash(Path(__file__).parents[1] / "uv.lock"),
            "dependencies": {
                name: version(name) for name in ("tinker", "tinker-cookbook", "transformers")
            },
            "prompt_versions": sorted(prompt_versions),
            "counts": dict(counts),
            "validated_rows": sum(counts.values()),
            "rendered_rows": len(lengths),
            "final_validation": "schema_and_provenance_only",
            "max_tokens": max(lengths),
            "min_target_tokens": min(target_counts),
        }
    )
    if output:
        write(output, artifact)
    return artifact
