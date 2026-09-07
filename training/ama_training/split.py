"""Persisted seed-0 80/10/10 partitions, grouping conversations and synthetic families.

Pass --previous for every later export in the same experiment. Omitting it starts
an independent lineage; there is no global ledger that discovers earlier splits.
"""
import argparse
import random
from collections import Counter
from pathlib import Path

from ama_training.provenance import jsonl, read, seal, verify_dataset, write

PARTITIONS = ("train", "selection", "final")


def _validate_persisted_assignments(split):
    for field in ("assignments", "family_assignments"):
        values = split.get(field)
        if (
            not isinstance(values, dict)
            or not values
            or any(
                not isinstance(identity, str)
                or not identity.strip()
                or not isinstance(partition, str)
                or partition not in PARTITIONS
                for identity, partition in values.items()
            )
        ):
            raise ValueError(f"invalid persisted {field}")
    counts = split.get("group_counts")
    if (
        not isinstance(counts, dict)
        or set(counts) != set(PARTITIONS)
        or any(type(count) is not int or count <= 0 for count in counts.values())
    ):
        raise ValueError("persisted split requires nonempty train/selection/final group counts")


def make_split(dataset_path, output, previous=None):
    dataset = verify_dataset(dataset_path)
    rows = jsonl(Path(dataset_path).parent / "ama-traces-qwen.jsonl")
    parent = read(previous, "ama_split") if previous else None
    if parent and (parent["seed"] != 0 or parent["ratios"] != [80, 10, 10]):
        raise ValueError("incompatible previous split policy")
    if parent:
        _validate_persisted_assignments(parent)
    families, union = {}, {}

    def find(x):
        union.setdefault(x, x)
        if union[x] != x:
            union[x] = find(union[x])
        return union[x]

    for row in rows:
        cid = row["conversation_id"]
        find(cid)
        if not row.get("family_ids"):
            raise ValueError("every conversation needs reviewed synthetic families")
        for family in row["family_ids"]:
            if family in families:
                union[find(cid)] = find(families[family])
            families[family] = cid
    groups = {}
    for cid in sorted(union):
        groups.setdefault(find(cid), []).append(cid)
    if len(groups) < 10:
        raise ValueError("need at least 10 independent conversation/family groups for 80/10/10")
    ordered = sorted(groups.values())
    random.Random(0).shuffle(ordered)
    assignments, family_assignments = {}, {}
    previous_c = parent["assignments"] if parent else {}
    previous_f = parent["family_assignments"] if parent else {}
    counts = Counter()
    pending = []
    for cids in ordered:
        fs = sorted(f for f, cid in families.items() if find(cid) == find(cids[0]))
        inherited = {previous_c[c] for c in cids if c in previous_c} | {
            previous_f[f] for f in fs if f in previous_f
        }
        if len(inherited) > 1:
            raise ValueError(
                "new family bridge crosses frozen partitions; reject/review that family"
            )
        if inherited:
            partition = inherited.pop()
            assignments.update(dict.fromkeys(cids, partition))
            family_assignments.update(dict.fromkeys(fs, partition))
            counts[partition] += 1
        else:
            pending.append((cids, fs))
    targets = {"selection": max(1, len(groups) // 10), "final": max(1, len(groups) // 10)}
    targets["train"] = len(groups) - targets["selection"] - targets["final"]
    for index, (cids, fs) in enumerate(pending):
        empty = [partition for partition in PARTITIONS if counts[partition] == 0]
        # Frozen assignments can dominate one partition. Reserve remaining new
        # groups for empty partitions before chasing the approximate ratio.
        choices = empty if len(pending) - index <= len(empty) else PARTITIONS
        partition = max(choices, key=lambda p: (targets[p] - counts[p], -PARTITIONS.index(p)))
        assignments.update(dict.fromkeys(cids, partition))
        family_assignments.update(dict.fromkeys(fs, partition))
        counts[partition] += 1
    if any(counts[partition] == 0 for partition in PARTITIONS):
        raise ValueError(
            "split requires nonempty train/selection/final partitions; include frozen "
            "groups from each partition or enough new independent groups"
        )
    # Retain identities absent from this snapshot so future reappearance cannot move them.
    artifact = seal(
        {
            "schema_version": 1,
            "kind": "ama_split",
            "seed": 0,
            "ratios": [80, 10, 10],
            "dataset_sha256": dataset["artifact_sha256"],
            "parent_split_sha256": parent["artifact_sha256"] if parent else None,
            "assignments": {**previous_c, **assignments},
            "family_assignments": {**previous_f, **family_assignments},
            "group_counts": dict(counts),
        }
    )
    output = Path(output)
    if output.exists():
        raise ValueError("split output already exists; use a new version and --previous")
    return write(output, artifact)


def verify_split(path, dataset_sha256, rows):
    split = read(path, "ama_split")
    if (
        split["dataset_sha256"] != dataset_sha256
        or split["seed"] != 0
        or split["ratios"] != [80, 10, 10]
    ):
        raise ValueError("split/dataset lineage mismatch")
    _validate_persisted_assignments(split)
    observed = set()
    for row in rows:
        partition = split["assignments"].get(row["conversation_id"])
        if (
            partition not in PARTITIONS
            or not row.get("family_ids")
            or any(split["family_assignments"].get(f) != partition for f in row["family_ids"])
        ):
            raise ValueError("conversation/family partition mismatch")
        observed.add(partition)
    if observed != set(PARTITIONS):
        raise ValueError("selected construction requires nonempty train/selection/final partitions")
    return split


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument(
        "--previous",
        help="required for later exports in the same experiment to preserve frozen assignments",
    )
    args = parser.parse_args()
    print(make_split(args.dataset, args.out, args.previous)["artifact_sha256"])


if __name__ == "__main__":
    main()
