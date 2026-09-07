import json
from pathlib import Path
import pytest
from ama_training.provenance import digest, seal, write
from ama_training.registry import load_registry
from ama_training.release import behavioral, claim_final, evaluate_final, promote, rollback, select
from ama_training.sample import load_fixtures


def behavior(
    selected, artifact, serving, partition="selection", decision=None, score=1, critical=True
):
    report = {
        "schema_version": 1,
        "report_type": "ama_behavioral_eval",
        "report_id": "report",
        "candidate_id": selected["candidate_id"],
        "checkpoint_path": selected["checkpoint_path"],
        "model_artifact_sha256": artifact["artifact_sha256"],
        "serving_config_sha256": serving["serving_config_sha256"],
        "dataset_sha256": partition + "-suite",
        "partition": partition,
        "profile": "production",
        "selection_decision_sha256": decision,
        "call_settings": serving["config"]["call_settings"],
        "inference_base_url": serving["endpoint"],
        "model": serving["model"],
        "observed_models": [serving["model"]],
        "summary": {
            "metadata": {
                "promptSha256": "prompt",
                "promptManifestSha256": "promptmanifest",
                "scorerSha256": "scorer",
                "transportSha256": "transport",
                "sdkVersion": "1",
                "judgeModelConfig": {"model": "openai/test"},
                "judgeCallSettings": {"maxOutputTokens": 100},
            }
        },
        "counts": {
            "expected": 2,
            "completed": 2,
            "failed": 0,
            "judge_expected": 1,
            "judge_completed": 1,
            "judge_skipped": 0,
        },
        "results": [
            {
                "case_id": partition + "-a",
                "category": "work",
                "passed": True,
                "critical_passed": critical,
                "critical_privacy_passed": critical,
                "score": score,
                "judge_status": "passed",
            },
            {
                "case_id": partition + "-b",
                "category": "privacy",
                "passed": True,
                "critical_passed": True,
                "critical_privacy_passed": True,
                "score": score,
                "judge_status": "not_required",
            },
        ],
    }
    return {**report, "report_sha256": digest(report)}


@pytest.fixture
def release_files(tmp_path):
    policy = seal(
        {
            "schema_version": 1,
            "kind": "ama_release_policy",
            "selection_dataset_sha256": "selection-suite",
            "final_dataset_sha256": "final-suite",
            "selection_case_ids": ["selection-a", "selection-b"],
            "final_case_ids": ["final-a", "final-b"],
            "selection_judge_case_ids": ["selection-a"],
            "final_judge_case_ids": ["final-a"],
            "selection_case_categories": {"selection-a": "work", "selection-b": "privacy"},
            "final_case_categories": {"final-a": "work", "final-b": "privacy"},
            "min_selection_score": 0.85,
            "min_final_score": 0.85,
            "min_category_score": 0.75,
        }
    )
    write(tmp_path / "policy.json", policy)
    fixtures = load_fixtures()
    candidates = {}
    entries = []
    evidence = {}
    split = seal(
        {
            "schema_version": 1,
            "kind": "ama_split",
            "dataset_sha256": "corpus",
            "assignments": {"c1": "train", "c2": "selection", "c3": "final"},
            "family_assignments": {"f1": "train", "f2": "selection", "f3": "final"},
        }
    )
    # Candidate high-score has a worse NLL and later step; behavior must rank first.
    for name, score, nll, step in [("low-score", 0.9, 0.1, 1), ("high-score", 1, 0.5, 2)]:
        root = tmp_path / name
        root.mkdir()
        selected = seal(
            {
                "schema_version": 1,
                "kind": "ama_candidate",
                "candidate_id": name,
                "preset": "qwen3.5-4b",
                "checkpoint_path": f"tinker://r/sampler_weights/{name}",
                "state_path": f"tinker://r/weights/{name}",
                "dataset_sha256": "corpus",
                "split_sha256": split["artifact_sha256"],
                "split_manifest": split,
                "training_config_sha256": "config",
                "step": step,
                "evaluation_datasets": {
                    "selection_dataset_sha256": "selection-suite",
                    "final_dataset_sha256": "final-suite",
                },
                "prompt_versions": ["v1", "v2"],
                "partition_counts": {"train": 16, "selection": 2, "final": 2},
            }
        )
        candidates[name] = selected
        from ama_training.provenance import file_hash

        model_dir = root / "model"
        model_dir.mkdir()
        (model_dir / "model.safetensors").write_bytes(b"fake model")
        (model_dir / "config.json").write_text("{}")
        (model_dir / "tokenizer_config.json").write_text("{}")
        artifact = seal(
            {
                "schema_version": 1,
                "kind": "ama_model_artifact",
                "candidate_id": name,
                "checkpoint_path": selected["checkpoint_path"],
                "preset": selected["preset"],
                "format": "merged",
                "files": {
                    name: file_hash(model_dir / name)
                    for name in ["model.safetensors", "config.json", "tokenizer_config.json"]
                },
            }
        )
        write(model_dir / "artifact-manifest.json", artifact)
        identity = {
            "schema_version": 1,
            "candidate_id": name,
            "checkpoint_path": selected["checkpoint_path"],
        }
        nll_report = seal(
            {
                **identity,
                "kind": "ama_nll",
                "dataset_sha256": "corpus",
                "split_sha256": split["artifact_sha256"],
                "training_config_sha256": "config",
                "partition": "selection",
                "examples": 2,
                "nll": nll,
            }
        )
        write(root / "nll.json", nll_report)
        smoke = seal(
            {
                **identity,
                "kind": "ama_smoke",
                "dataset_sha256": "corpus",
                "training_config_sha256": "config",
                "prompt_versions": ["v1", "v2"],
                "fixture_ids": [f["id"] for f in fixtures["fixtures"]],
                "fixtures_sha256": digest(fixtures),
                "results": [
                    {"prompt_version": v, "fixture_id": f["id"], "passed": True}
                    for v in ["v1", "v2"]
                    for f in fixtures["fixtures"]
                ],
            }
        )
        write(root / "smoke.json", smoke)
        config = {"call_settings": {"maxOutputTokens": 2048}, "server": {"identity": "vllm"}}
        serving = seal(
            {
                **identity,
                "kind": "ama_serving_verification",
                "model_artifact_sha256": artifact["artifact_sha256"],
                "config": config,
                "serving_config_sha256": digest(config),
                "endpoint": "http://localhost:8000/v1",
                "model": "ama-artifact-" + artifact["artifact_sha256"],
                "passed": True,
                "checks": dict.fromkeys(
                    ["artifact_identity", "template_parity", "tool_call", "stream", "readiness"],
                    True,
                ),
            }
        )
        write(root / "serving.json", serving)
        write(root / "selection.json", behavior(selected, artifact, serving, score=score))
        entries.append(
            {
                "candidate_id": name,
                **{
                    key: str(
                        model_dir / "artifact-manifest.json"
                        if key == "artifact"
                        else root / (key + ".json")
                    )
                    for key in ["artifact", "nll", "smoke", "serving", "selection"]
                },
            }
        )
        evidence[name] = (selected, artifact, serving, nll_report)
    registry = {
        "schema_version": 1,
        "kind": "ama_registry",
        "candidates": candidates,
        "latest_training_state": {},
        "deployable": {},
        "decisions": {},
        "history": [],
    }
    write(tmp_path / "registry.json", seal(registry))
    write(tmp_path / "bundle.json", entries)
    return tmp_path, policy, evidence


def lock(files):
    root, _, _ = files
    return select(
        root / "registry.json", root / "policy.json", root / "bundle.json", root / "decision.json"
    )


def final_reports(files, decision, critical=True):
    root, policy, evidence = files
    selected, artifact, serving, nll = evidence[decision["winner"]["candidate_id"]]
    attempt = claim_final(root / "registry.json", root / "decision.json")
    report = behavior(
        selected, artifact, serving, "final", decision["artifact_sha256"], critical=critical
    )
    report.pop("report_sha256")
    report["final_attempt_id"] = attempt
    report["report_sha256"] = digest(report)
    write(root / "final.json", report)
    final_nll = seal(
        {
            **{k: v for k, v in nll.items() if k != "artifact_sha256"},
            "partition": "final",
            "selection_decision_sha256": decision["artifact_sha256"],
            "final_attempt_id": attempt,
        }
    )
    write(root / "final-nll.json", final_nll)


def test_ranks_behavior_before_nll_then_locks_and_promotes(release_files):
    root, _, _ = release_files
    decision = lock(release_files)
    assert decision["winner"]["candidate_id"] == "high-score"
    with pytest.raises(ValueError, match="already has a locked"):
        lock(release_files)
    final_reports(release_files, decision)
    pointer = promote(
        root / "registry.json", root / "decision.json", root / "final.json", root / "final-nll.json"
    )
    assert pointer["candidate_id"] == "high-score"
    assert load_registry(root / "registry.json")["deployable"]["qwen3.5-4b"] == pointer
    with pytest.raises(ValueError, match="already consumed"):
        promote(
            root / "registry.json",
            root / "decision.json",
            root / "final.json",
            root / "final-nll.json",
        )


def test_final_failure_stops_no_runner_up_and_preserves_previous(release_files):
    root, _, _ = release_files
    registry = load_registry(root / "registry.json")
    registry["deployable"]["qwen3.5-4b"] = {"candidate_id": "previous"}
    write(root / "registry.json", seal(registry))
    decision = lock(release_files)
    final_reports(release_files, decision, critical=False)
    with pytest.raises(ValueError, match="stopped without trying"):
        promote(
            root / "registry.json",
            root / "decision.json",
            root / "final.json",
            root / "final-nll.json",
        )
    registry = load_registry(root / "registry.json")
    assert registry["deployable"]["qwen3.5-4b"]["candidate_id"] == "previous"
    assert registry["decisions"]["final-suite"]["status"] == "final_failed"
    with pytest.raises(ValueError, match="already has a locked"):
        lock(release_files)


def test_gate_rejects_wrong_identity_skipped_judge_and_missing_case(release_files):
    root, policy, evidence = release_files
    selected, artifact, serving, _ = evidence["high-score"]
    good = behavior(selected, artifact, serving)
    for mutate in [
        lambda r: r.update(checkpoint_path="wrong"),
        lambda r: r["counts"].update(judge_skipped=1),
        lambda r: r["results"].pop(),
    ]:
        report = json.loads(json.dumps(good))
        report.pop("report_sha256")
        mutate(report)
        report["report_sha256"] = digest(report)
        with pytest.raises(ValueError):
            behavioral(
                report,
                selected,
                policy,
                "selection",
                artifact["artifact_sha256"],
                serving["serving_config_sha256"],
            )


def test_rejects_partial_prompt_version_smoke(release_files):
    root, _, _ = release_files
    for name in ("low-score", "high-score"):
        file = root / name / "smoke.json"
        report = json.loads(file.read_text())
        report.pop("artifact_sha256")
        report["results"] = report["results"][:1]
        write(file, seal(report))
    with pytest.raises(ValueError, match="no passing candidates"):
        lock(release_files)


def test_rollback_restores_previous_pointer(release_files):
    root, _, _ = release_files
    registry = load_registry(root / "registry.json")
    previous = {"candidate_id": "previous"}
    registry["deployable"]["qwen3.5-4b"] = previous
    write(root / "registry.json", seal(registry))
    decision = lock(release_files)
    final_reports(release_files, decision)
    promote(
        root / "registry.json", root / "decision.json", root / "final.json", root / "final-nll.json"
    )
    assert rollback(root / "registry.json", "qwen3.5-4b") == previous


def test_final_orchestrator_claims_before_calls_and_stops_on_process_failure(release_files):
    root, _, _ = release_files
    lock(release_files)
    write(root / "args.json", ["preset=qwen3.5-4b", "warm_start=false"])
    calls = []

    def fail(*args, **kwargs):
        state = load_registry(root / "registry.json")["decisions"]["final-suite"]
        assert state["status"] == "final_running"
        assert kwargs["env"]["AMA_EVAL_FINAL_ATTEMPT_ID"] == state["final_attempt_id"]
        calls.append(args)
        raise RuntimeError("simulated process failure")

    with pytest.raises(RuntimeError):
        evaluate_final(
            root / "registry.json",
            root / "decision.json",
            root / "args.json",
            root / "attempt",
            runner=fail,
        )
    assert len(calls) == 1
    assert (
        load_registry(root / "registry.json")["decisions"]["final-suite"]["status"]
        == "final_failed"
    )
    with pytest.raises(ValueError, match="claimed/consumed"):
        evaluate_final(
            root / "registry.json",
            root / "decision.json",
            root / "args.json",
            root / "attempt2",
            runner=fail,
        )


def test_final_orchestrator_automatically_promotes_bound_reports(release_files):
    root, _, evidence = release_files
    decision = lock(release_files)
    selected, artifact, serving, nll = evidence[decision["winner"]["candidate_id"]]
    write(root / "args.json", ["preset=qwen3.5-4b", "warm_start=false"])
    calls = []

    def complete(command, **kwargs):
        calls.append(command)
        assert kwargs["env"]["AMA_EVAL_CHECKPOINT_DECISION"] == str(root / "decision.json")
        attempt = kwargs["env"]["AMA_EVAL_FINAL_ATTEMPT_ID"]
        if len(calls) == 1:
            report = behavior(selected, artifact, serving, "final", decision["artifact_sha256"])
            report.pop("report_sha256")
            report["final_attempt_id"] = attempt
            report["report_sha256"] = digest(report)
            write(kwargs["env"]["AMA_EVAL_OUTPUT_PATH"], report)
        else:
            output = next(arg.split("=", 1)[1] for arg in command if arg.startswith("output="))
            write(
                output,
                seal(
                    {
                        **{k: v for k, v in nll.items() if k != "artifact_sha256"},
                        "partition": "final",
                        "selection_decision_sha256": decision["artifact_sha256"],
                        "final_attempt_id": attempt,
                    }
                ),
            )

    pointer = evaluate_final(
        root / "registry.json",
        root / "decision.json",
        root / "args.json",
        root / "attempt",
        runner=complete,
    )
    assert pointer["candidate_id"] == "high-score"
    assert len(calls) == 2
    assert load_registry(root / "registry.json")["decisions"]["final-suite"]["status"] == "promoted"


def test_concurrent_final_claims_have_exactly_one_winner(release_files):
    from concurrent.futures import ThreadPoolExecutor

    root, _, _ = release_files
    lock(release_files)

    def attempt(_):
        try:
            return claim_final(root / "registry.json", root / "decision.json")
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        claims = list(pool.map(attempt, range(8)))
    assert sum(claim is not None for claim in claims) == 1
    state = load_registry(root / "registry.json")["decisions"]["final-suite"]
    assert state["status"] == "final_running" and state["final_attempt_id"] in claims


@pytest.mark.parametrize("bad_payload", ["not json", '{"bad": NaN}', "[]"])
def test_malformed_final_evidence_records_consumed_failure(release_files, bad_payload):
    root, _, _ = release_files
    decision = lock(release_files)
    final_reports(release_files, decision)
    (root / "final.json").write_text(bad_payload)
    with pytest.raises(ValueError, match="stopped without trying"):
        promote(
            root / "registry.json",
            root / "decision.json",
            root / "final.json",
            root / "final-nll.json",
        )
    assert (
        load_registry(root / "registry.json")["decisions"]["final-suite"]["status"]
        == "final_failed"
    )
    assert load_registry(root / "registry.json")["deployable"] == {}


def test_missing_final_report_records_consumed_failure(release_files):
    root, _, _ = release_files
    decision = lock(release_files)
    final_reports(release_files, decision)
    (root / "final.json").unlink()
    with pytest.raises(ValueError, match="stopped without trying"):
        promote(
            root / "registry.json",
            root / "decision.json",
            root / "final.json",
            root / "final-nll.json",
        )
    assert (
        load_registry(root / "registry.json")["decisions"]["final-suite"]["status"]
        == "final_failed"
    )


def test_ancestor_provenance_rejects_unknown_parents_eval_drift_and_split_movement(release_files):
    from ama_training.registry import verify_candidate_lineage

    root, _, evidence = release_files
    registry = load_registry(root / "registry.json")
    parent = evidence["low-score"][0]

    def child(**overrides):
        return seal(
            {
                **{
                    key: value
                    for key, value in evidence["high-score"][0].items()
                    if key != "artifact_sha256"
                },
                "warm_start": parent["state_path"],
                "parent_candidate_id": parent["candidate_id"],
                "parent_candidate_sha256": parent["artifact_sha256"],
                **overrides,
            }
        )

    verify_candidate_lineage(child(), registry)
    with pytest.raises(ValueError, match="unverified warm-start"):
        verify_candidate_lineage(child(parent_candidate_id="missing"), registry)
    with pytest.raises(ValueError, match="decontamination differs"):
        verify_candidate_lineage(
            child(
                evaluation_datasets={
                    "selection_dataset_sha256": "selection-suite",
                    "final_dataset_sha256": "different-final",
                }
            ),
            registry,
        )
    old = parent["split_manifest"]
    moved = seal(
        {
            **{key: value for key, value in old.items() if key != "artifact_sha256"},
            "assignments": {**old["assignments"], "c1": "final"},
        }
    )
    with pytest.raises(ValueError, match="moved or forgot"):
        verify_candidate_lineage(
            child(split_manifest=moved, split_sha256=moved["artifact_sha256"]), registry
        )
    changed_parent = seal(
        {**{key: value for key, value in parent.items() if key != "artifact_sha256"}, "step": 999}
    )
    registry["candidates"][parent["candidate_id"]] = changed_parent
    with pytest.raises(ValueError, match="unverified warm-start"):
        verify_candidate_lineage(child(), registry)


def test_failed_atomic_registry_write_never_updates_pointer(release_files, monkeypatch):
    root, _, _ = release_files
    decision = lock(release_files)
    final_reports(release_files, decision)
    before = (root / "registry.json").read_bytes()
    original = Path.replace

    def fail_replace(self, target):
        if Path(target) == root / "registry.json":
            raise OSError("simulated replacement failure")
        return original(self, target)

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(OSError):
        promote(
            root / "registry.json",
            root / "decision.json",
            root / "final.json",
            root / "final-nll.json",
        )
    assert (root / "registry.json").read_bytes() == before
    assert load_registry(root / "registry.json")["deployable"] == {}


def test_concurrent_promotions_commit_one_pointer_and_history_entry(release_files):
    from concurrent.futures import ThreadPoolExecutor

    root, _, _ = release_files
    decision = lock(release_files)
    final_reports(release_files, decision)

    def attempt(_):
        try:
            return promote(
                root / "registry.json",
                root / "decision.json",
                root / "final.json",
                root / "final-nll.json",
            )
        except ValueError:
            return None

    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(attempt, range(4)))
    assert sum(result is not None for result in results) == 1
    registry = load_registry(root / "registry.json")
    assert len(registry["history"]) == 1
    assert registry["deployable"]["qwen3.5-4b"]["candidate_id"] == "high-score"


def test_changed_candidate_cannot_claim_final_or_be_silently_promoted(release_files):
    root, _, _ = release_files
    lock(release_files)
    registry = load_registry(root / "registry.json")
    selected = registry["candidates"]["high-score"]
    registry["candidates"]["high-score"] = seal(
        {**{key: value for key, value in selected.items() if key != "artifact_sha256"}, "step": 999}
    )
    write(root / "registry.json", seal(registry))
    with pytest.raises(ValueError, match="changed before final claim"):
        claim_final(root / "registry.json", root / "decision.json")
    assert load_registry(root / "registry.json")["decisions"]["final-suite"]["status"] == "locked"


def test_unknown_legacy_warm_start_is_rejected_before_registration(verified_export, tmp_path):
    from ama_training.preflight import run_preflight
    from ama_training.registry import resolve_parent
    from ama_training.split import make_split
    from test_pipeline import config_for

    root = verified_export
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    preflight = run_preflight(
        config_for(root, load_checkpoint_path="tinker://legacy/weights/final")
    )
    with pytest.raises(ValueError, match="verified candidate"):
        resolve_parent("tinker://legacy/weights/final", "qwen3.5-4b", preflight, {"candidates": {}})
    with pytest.raises(ValueError, match="actual training configuration"):
        resolve_parent(None, "qwen3.5-4b", preflight, {"candidates": {}})


@pytest.mark.parametrize(
    "fields",
    [{"passed": False}, {"passed": True, "failure_type": "RuntimeError"}, {"passed": None}],
)
def test_serving_failure_rejected_even_if_individual_checks_are_true(release_files, fields):
    root, _, _ = release_files
    for name in ("low-score", "high-score"):
        file = root / name / "serving.json"
        report = json.loads(file.read_text())
        report.pop("artifact_sha256")
        report.update(fields)
        write(file, seal(report))
    with pytest.raises(ValueError, match="serving verification failed"):
        lock(release_files)
    assert load_registry(root / "registry.json")["decisions"] == {}


@pytest.mark.parametrize("difference", ["scorer", "call_settings", "reasoning_effort"])
def test_selection_rejects_mixed_evaluation_configuration(release_files, difference):
    root, _, _ = release_files
    directory = root / "high-score"
    serving = json.loads((directory / "serving.json").read_text())
    serving.pop("artifact_sha256")
    report = json.loads((directory / "selection.json").read_text())
    report.pop("report_sha256")
    if difference == "scorer":
        report["summary"]["metadata"]["scorerSha256"] = "a-different-scorer"
    elif difference == "call_settings":
        serving["config"]["call_settings"]["maxOutputTokens"] = 4096
        report["call_settings"] = serving["config"]["call_settings"]
    else:
        serving["config"]["reasoning_effort"] = 0
        report["summary"]["modelConfig"] = {
            "providerOptions": {"inference": {"reasoning_effort": 0}}
        }
    serving["serving_config_sha256"] = digest(serving["config"])
    report["serving_config_sha256"] = serving["serving_config_sha256"]
    write(directory / "serving.json", seal(serving))
    write(directory / "selection.json", {**report, "report_sha256": digest(report)})
    with pytest.raises(ValueError, match="mixed evaluation configurations"):
        lock(release_files)
    assert load_registry(root / "registry.json")["decisions"] == {}


def test_selection_allows_candidate_specific_endpoints_and_model_artifacts(release_files):
    root, _, _ = release_files
    directory = root / "high-score"
    serving = json.loads((directory / "serving.json").read_text())
    serving.pop("artifact_sha256")
    report = json.loads((directory / "selection.json").read_text())
    report.pop("report_sha256")
    serving["endpoint"] = "http://localhost:9000/v1"
    report["inference_base_url"] = serving["endpoint"]
    write(directory / "serving.json", seal(serving))
    write(directory / "selection.json", {**report, "report_sha256": digest(report)})
    assert lock(release_files)["winner"]["candidate_id"] == "high-score"


@pytest.mark.parametrize(
    "field,value",
    [
        ("min_selection_score", 0.84),
        ("min_final_score", 0.84),
        ("min_category_score", 0.74),
        ("min_final_score", True),
        ("max_critical_failures", 1),
    ],
)
def test_weakened_or_invalid_policy_is_rejected(release_files, field, value):
    root, policy, _ = release_files
    policy = {
        **{key: item for key, item in policy.items() if key != "artifact_sha256"},
        field: value,
    }
    write(root / "policy.json", seal(policy))
    with pytest.raises(ValueError, match="release policy"):
        lock(release_files)
    assert load_registry(root / "registry.json")["decisions"] == {}
