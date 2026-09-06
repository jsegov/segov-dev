"""Content-addressed local artifacts. Hashes detect change; review is an explicit human decision."""
import hashlib
import json
import math
import os
import rfc8785
import uuid
from pathlib import Path


def canonical(value):
    if isinstance(value, dict):
        return {key: canonical(item) for key, item in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [canonical(item) for item in value]
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("non-finite number")
    return value


def digest(value):
    return hashlib.sha256(rfc8785.dumps(value)).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def seal(value):
    return {**value, "artifact_sha256": digest(value)}


def verify(value, kind=None, hash_key="artifact_sha256"):
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or (kind and value.get("kind") != kind)
    ):
        raise ValueError(f"invalid {kind or 'artifact'} schema")
    if digest({k: v for k, v in value.items() if k != hash_key}) != value.get(hash_key):
        raise ValueError("artifact hash mismatch")
    return value


def read(path, kind=None):
    return verify(json.loads(Path(path).read_text()), kind)


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{uuid.uuid4()}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            stream.write(json.dumps(canonical(value), indent=2, ensure_ascii=False) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temporary.unlink(missing_ok=True)
    return value


def verify_files(root, files):
    root = Path(root).resolve()
    for name, expected in files.items():
        target = (root / name).resolve()
        if not target.is_relative_to(root) or target == root or file_hash(target) != expected:
            raise ValueError(f"artifact file changed: {name}")


def verify_dataset(manifest_path):
    manifest_path = Path(manifest_path)
    manifest = read(manifest_path, "ama_dataset")
    root = manifest_path.parent
    if manifest.get("corpus_class") != "synthetic":
        raise ValueError("training requires synthetic-only reviewed data")
    required = {
        "policy.json",
        "reviews.json",
        "evaluation-fingerprints.json",
        "snapshot-manifest.json",
        "source-traces.jsonl",
        "source-prompts.json",
        "prompt-manifest.json",
        "ama-traces-qwen.jsonl",
        "ama-traces-inkling.jsonl",
    }
    if not required.issubset(manifest["files"]):
        raise ValueError("incomplete dataset lineage")
    verify_files(root, manifest["files"])
    snapshot = read(root / "snapshot-manifest.json", "ama_snapshot")
    if snapshot["artifact_sha256"] != manifest["snapshot_sha256"]:
        raise ValueError("snapshot lineage mismatch")
    if (
        file_hash(root / "source-traces.jsonl") != snapshot["files"]["traces.jsonl"]
        or file_hash(root / "source-prompts.json") != snapshot["files"]["prompt-manifest.json"]
    ):
        raise ValueError("source snapshot changed")
    reviews = json.loads((root / "reviews.json").read_text())
    policy = json.loads((root / "policy.json").read_text())
    fingerprints = json.loads((root / "evaluation-fingerprints.json").read_text())
    if (
        reviews["snapshot_sha256"] != snapshot["artifact_sha256"]
        or policy.get("corpus_class") != "synthetic"
        or policy.get("evaluation_fingerprints_sha256") != digest(fingerprints)
    ):
        raise ValueError("review/policy lineage mismatch")
    source = {row["id"]: row for row in jsonl(root / "source-traces.jsonl")}
    for file in ["ama-traces-qwen.jsonl", "ama-traces-inkling.jsonl"]:
        for row in jsonl(root / file):
            trace_ids = row.get("trace_ids", [row.get("trace_id")])
            for trace_id in trace_ids:
                raw, review = source[trace_id], reviews["rows"][trace_id]
                if (
                    review["row_sha256"] != digest(raw)
                    or review["decision"] != "approved"
                    or review["corpus_class"] != "synthetic"
                    or not review.get("reason", "").strip()
                    or review.get("family_id") not in row["family_ids"]
                    or not any(
                        raw["conversation_id"].startswith(p)
                        for p in policy["conversation_prefixes"]
                    )
                    or raw["model"] not in policy["allowed_models"]
                    or raw["response_model"] not in policy["allowed_response_models"]
                    or raw["system_prompt_version"] not in policy["allowed_prompt_versions"]
                    or raw["finish_reason"] != "stop"
                ):
                    raise ValueError("export contains an ineligible trace")
    return manifest


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
