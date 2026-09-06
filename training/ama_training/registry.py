"""Training progress is separate from candidates and the deployable pointer."""
from contextlib import contextmanager
import fcntl
import json
from pathlib import Path

from ama_training.provenance import digest, jsonl, seal, verify, write

DEFAULT_REGISTRY = Path(__file__).resolve().parents[1] / "data" / "checkpoints.json"


def load_registry(path=DEFAULT_REGISTRY):
    if not Path(path).exists():
        return {
            "schema_version": 1,
            "kind": "ama_registry",
            "latest_training_state": {},
            "candidates": {},
            "deployable": {},
            "history": [],
            "decisions": {},
        }
    data = json.loads(Path(path).read_text())
    if data.get("kind") == "ama_registry":
        verified = verify(data, "ama_registry")
        return {k: v for k, v in verified.items() if k != "artifact_sha256"}
    # Legacy pointers are progress only. They never become deployable by migration.
    return {
        "schema_version": 1,
        "kind": "ama_registry",
        "latest_training_state": data,
        "candidates": {},
        "deployable": {},
        "history": [],
        "decisions": {},
    }


@contextmanager
def transaction(path=DEFAULT_REGISTRY):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.with_suffix(path.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        registry = load_registry(path)
        yield registry
        write(path, seal(registry))


def candidate(candidate_id, path=DEFAULT_REGISTRY):
    value = load_registry(path)["candidates"].get(candidate_id)
    if not value:
        raise ValueError("unknown candidate")
    return verify(value, "ama_candidate")


def _verified_split(value):
    split = verify(value["split_manifest"], "ama_split")
    if (
        split["artifact_sha256"] != value["split_sha256"]
        or split["dataset_sha256"] != value["dataset_sha256"]
    ):
        raise ValueError("candidate split lineage mismatch")
    return split


def _preserves_partitions(child, parent):
    current, previous = _verified_split(child), _verified_split(parent)
    for key in ("assignments", "family_assignments"):
        if any(
            current[key].get(identity) != partition for identity, partition in previous[key].items()
        ):
            raise ValueError("warm-start split moved or forgot an ancestor conversation/family")


def verify_candidate_lineage(selected, registry, expected_evaluations=None):
    """Follow immutable parents to a base run; preserve every ancestor's holdout identities."""
    seen = set()
    current = selected
    expected = expected_evaluations or selected["evaluation_datasets"]
    while True:
        verify(current, "ama_candidate")
        identity = current["candidate_id"]
        if identity in seen:
            raise ValueError("cyclic checkpoint ancestry")
        seen.add(identity)
        _verified_split(current)
        if (
            current.get("evaluation_datasets") != expected
            or current["preset"] != selected["preset"]
        ):
            raise ValueError("ancestor preset or evaluation decontamination differs")
        warm_start, parent_id = current.get("warm_start"), current.get("parent_candidate_id")
        if not warm_start:
            if parent_id or current.get("parent_candidate_sha256"):
                raise ValueError("base run has unexpected checkpoint ancestry")
            return
        parent = registry["candidates"].get(parent_id)
        if (
            not parent
            or current.get("parent_candidate_sha256") != parent.get("artifact_sha256")
            or warm_start not in (parent.get("state_path"), parent.get("checkpoint_path"))
        ):
            raise ValueError("unverified warm-start checkpoint ancestry")
        _preserves_partitions(current, parent)
        current = parent


def resolve_parent(warm_start, preset, preflight, registry):
    if preflight["training_config"]["load_checkpoint_path"] != warm_start:
        raise ValueError("warm-start ancestry differs from the actual training configuration")
    if not warm_start:
        return None
    matches = [
        value
        for value in registry["candidates"].values()
        if warm_start in (value.get("state_path"), value.get("checkpoint_path"))
    ]
    if len(matches) != 1 or matches[0]["preset"] != preset:
        raise ValueError(
            "warm start requires one verified candidate; use warm_start=false for legacy/unregistered weights"
        )
    parent = matches[0]
    verify_candidate_lineage(parent, registry, preflight["evaluation_datasets"])
    _preserves_partitions(preflight, parent)
    return parent


def register_checkpoints(preset, log_path, preflight, warm_start, path=DEFAULT_REGISTRY):
    checkpoint_file = Path(log_path) / "checkpoints.jsonl"
    if not checkpoint_file.exists():
        return []
    checkpoints = jsonl(checkpoint_file)
    recorded = []
    with transaction(path) as registry:
        parent = resolve_parent(warm_start, preset, preflight, registry)
        for entry in checkpoints:
            state = entry.get("state_path")
            sampler = entry.get("sampler_path")
            if state:
                registry["latest_training_state"][preset] = {
                    "state_path": state,
                    "run_log": str(log_path),
                    "preflight_sha256": preflight["artifact_sha256"],
                }
            if not state or not sampler:
                continue
            identity = {
                "preset": preset,
                "checkpoint_path": sampler,
                "preflight_sha256": preflight["artifact_sha256"],
            }
            candidate_id = digest(identity)
            value = seal(
                {
                    "schema_version": 1,
                    "kind": "ama_candidate",
                    "candidate_id": candidate_id,
                    **identity,
                    "state_path": state,
                    "step": entry.get("batch", entry.get("step", 0)),
                    "warm_start": warm_start,
                    "parent_candidate_id": parent["candidate_id"] if parent else None,
                    "parent_candidate_sha256": parent["artifact_sha256"] if parent else None,
                    "dataset_sha256": preflight["dataset_sha256"],
                    "split_sha256": preflight["split_sha256"],
                    "split_manifest": preflight["split_manifest"],
                    "training_config_sha256": preflight["training_config_sha256"],
                    "prompt_versions": preflight["prompt_versions"],
                    "partition_counts": preflight["counts"],
                    "evaluation_datasets": preflight["evaluation_datasets"],
                    "run_log": str(log_path),
                }
            )
            old = registry["candidates"].get(candidate_id)
            if old and old != value:
                raise ValueError("candidate identity changed")
            registry["candidates"][candidate_id] = value
            recorded.append(candidate_id)
    return recorded
