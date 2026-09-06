"""Offline release gates: rank passing candidates, lock one final winner, promote or stop."""
import argparse
import json
import math
import os
import subprocess
import sys
import uuid
from pathlib import Path

from ama_training.provenance import digest, read, seal, verify, write
from ama_training.registry import (
    DEFAULT_REGISTRY,
    candidate,
    load_registry,
    transaction,
    verify_candidate_lineage,
)


def _bound(report, selected):
    for field in ("candidate_id", "checkpoint_path"):
        if report.get(field) != selected[field]:
            raise ValueError(f"report {field} does not match candidate")


def validate_policy(policy):
    verify(policy, "ama_release_policy")
    for field, minimum in (
        ("min_selection_score", 0.85),
        ("min_final_score", 0.85),
        ("min_category_score", 0.75),
    ):
        value = policy.get(field)
        if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= 1:
            raise ValueError(f"release policy {field} must be between {minimum} and 1")
    if policy.get("max_critical_failures", 0) != 0:
        raise ValueError("release policy must require zero critical failures")
    return policy


def behavioral(
    report, selected, policy, partition, artifact_hash, serving_hash, decision_hash=None
):
    validate_policy(policy)
    verify(report, hash_key="report_sha256")
    _bound(report, selected)
    if (
        report.get("report_type") != "ama_behavioral_eval"
        or report.get("partition") != partition
        or report.get("profile") != "production"
    ):
        raise ValueError("wrong behavioral report type/partition")
    for key, expected in (
        ("model_artifact_sha256", artifact_hash),
        ("serving_config_sha256", serving_hash),
        ("dataset_sha256", policy[f"{partition}_dataset_sha256"]),
    ):
        if not expected or report.get(key) != expected:
            raise ValueError(f"behavioral report {key} mismatch")
    if decision_hash and report.get("selection_decision_sha256") != decision_hash:
        raise ValueError("final report does not bind the locked selection decision")
    results, counts = report["results"], report["counts"]
    ids = [r["case_id"] for r in results]
    expected_ids = policy[f"{partition}_case_ids"]
    if len(ids) != len(set(ids)) or sorted(ids) != sorted(expected_ids) or not ids:
        raise ValueError("missing, duplicate, or unexpected evaluation cases")
    if (
        counts["expected"] != len(ids)
        or counts["completed"] != len(ids)
        or counts["failed"] != sum(r.get("passed") is not True for r in results)
    ):
        raise ValueError("evaluation is incomplete or failed")
    if counts["judge_skipped"] or counts["judge_completed"] != counts["judge_expected"]:
        raise ValueError("required judges incomplete")
    expected_judges = set(policy[f"{partition}_judge_case_ids"])
    expected_categories = policy[f"{partition}_case_categories"]
    if counts["judge_expected"] != len(expected_judges) or set(expected_categories) != set(ids):
        raise ValueError("judge/category coverage differs from policy")
    for result in results:
        if result.get("category") != expected_categories[result["case_id"]] or (
            result["judge_status"] != "not_required"
        ) != (result["case_id"] in expected_judges):
            raise ValueError("case category or required judge differs from policy")
        if (
            result.get("critical_passed") is not True
            or result.get("critical_privacy_passed") is not True
            or result.get("judge_status") not in {"passed", "failed", "not_required"}
        ):
            raise ValueError("behavioral/critical privacy/judge case failed")
        if (
            not isinstance(result.get("score"), (float, int))
            or not math.isfinite(result["score"])
            or not 0 <= result["score"] <= 1
        ):
            raise ValueError("invalid behavioral score")
    required_judges = sum(r["judge_status"] in {"passed", "failed"} for r in results)
    if required_judges != counts["judge_expected"]:
        raise ValueError("judge evidence counts disagree")
    categories = {r["category"] for r in results}
    for category in categories:
        scores = [r["score"] for r in results if r["category"] == category]
        if sum(scores) / len(scores) < policy["min_category_score"]:
            raise ValueError("category score below release policy")
    score = sum(r["score"] for r in results) / len(results)
    if score < policy[f"min_{partition}_score"]:
        raise ValueError("behavioral score below release policy")
    return score


def evaluation_configuration(behavior):
    metadata = behavior.get("summary", {}).get("metadata", {})
    keys = (
        "promptSha256",
        "promptManifestSha256",
        "scorerSha256",
        "transportSha256",
        "sdkVersion",
        "judgeModelConfig",
        "judgeCallSettings",
    )
    if any(key not in metadata or metadata[key] is None for key in keys):
        raise ValueError("evaluation source/judge configuration evidence missing")
    return {key: metadata[key] for key in keys}


def check_bundle(entry, selected, policy):
    if any(
        selected.get("evaluation_datasets", {}).get(key) != policy[key]
        for key in ("selection_dataset_sha256", "final_dataset_sha256")
    ):
        raise ValueError("training decontamination used different evaluation suites")
    from ama_training.serving_identity import load_model_artifact

    if Path(entry["artifact"]).name != "artifact-manifest.json":
        raise ValueError("expected immutable artifact-manifest.json")
    model = load_model_artifact(Path(entry["artifact"]).parent)
    _bound(model, selected)
    if model["format"] != "merged" or model["preset"] != selected["preset"]:
        raise ValueError("serving artifact format/preset mismatch")
    nll = read(entry["nll"], "ama_nll")
    _bound(nll, selected)
    if (
        nll.get("partition") != "selection"
        or nll.get("examples", 0) != selected["partition_counts"]["selection"]
        or not isinstance(nll.get("nll"), (int, float))
        or not math.isfinite(nll["nll"])
        or nll["nll"] < 0
    ):
        raise ValueError("finite complete selection NLL required")
    for field in ("dataset_sha256", "split_sha256", "training_config_sha256"):
        if nll[field] != selected[field]:
            raise ValueError("NLL training lineage differs")
    smoke = read(entry["smoke"], "ama_smoke")
    _bound(smoke, selected)
    if (
        smoke.get("training_config_sha256") != selected["training_config_sha256"]
        or smoke.get("dataset_sha256") != selected["dataset_sha256"]
    ):
        raise ValueError("smoke training lineage differs")
    if not smoke.get("results") or any(r.get("passed") is not True for r in smoke["results"]):
        raise ValueError("renderer smoke failed")
    from ama_training.sample import load_fixtures

    fixtures = load_fixtures()
    fixture_ids = [f["id"] for f in fixtures["fixtures"]]
    if (
        smoke.get("fixtures_sha256") != digest(fixtures)
        or smoke["fixture_ids"] != fixture_ids
        or smoke["prompt_versions"] != selected["prompt_versions"]
    ):
        raise ValueError("smoke fixture or prompt-version coverage changed")
    expected = {(v, c) for v in selected["prompt_versions"] for c in fixture_ids}
    actual = [(r["prompt_version"], r["fixture_id"]) for r in smoke["results"]]
    if not expected or len(actual) != len(expected) or set(actual) != expected:
        raise ValueError("smoke did not cover every prompt version/fixture")
    serving = read(entry["serving"], "ama_serving_verification")
    _bound(serving, selected)
    if serving.get("model_artifact_sha256") != model["artifact_sha256"] or digest(
        serving["config"]
    ) != serving.get("serving_config_sha256"):
        raise ValueError("serving artifact/config binding mismatch")
    if serving.get("passed") is not True or "failure_type" in serving:
        raise ValueError("serving verification failed, including late probe failures")
    if any(
        serving.get("checks", {}).get(key) is not True
        for key in ("artifact_identity", "template_parity", "tool_call", "stream", "readiness")
    ):
        raise ValueError("serving verification incomplete")
    behavior = json.loads(Path(entry["selection"]).read_text())
    score = behavioral(
        behavior,
        selected,
        policy,
        "selection",
        model["artifact_sha256"],
        serving["serving_config_sha256"],
    )
    verify_serving_behavior(serving, behavior)
    return {
        "candidate_id": selected["candidate_id"],
        "checkpoint_path": selected["checkpoint_path"],
        "preset": selected["preset"],
        "model_artifact_sha256": model["artifact_sha256"],
        "serving_config_sha256": serving["serving_config_sha256"],
        "selection_score": score,
        "selection_nll": nll["nll"],
        "step": selected["step"],
        "candidate_sha256": selected["artifact_sha256"],
        "serving": serving,
        "evaluation_configuration": evaluation_configuration(behavior),
        "evidence": {
            "artifact": model["artifact_sha256"],
            "nll": nll["artifact_sha256"],
            "smoke": smoke["artifact_sha256"],
            "serving": serving["artifact_sha256"],
            "selection": behavior["report_sha256"],
        },
    }


def verify_serving_behavior(serving, behavior):
    behavior_effort = (
        behavior.get("summary", {})
        .get("modelConfig", {})
        .get("providerOptions", {})
        .get("inference", {})
        .get("reasoning_effort")
    )
    if behavior_effort != serving["config"].get("reasoning_effort"):
        raise ValueError("behavioral and serving reasoning effort differ")
    if behavior.get("call_settings") != serving["config"].get("call_settings"):
        raise ValueError("behavioral and serving call settings differ")
    if behavior.get("model") != serving.get("model") or behavior.get("observed_models") != [
        serving.get("model")
    ]:
        raise ValueError("behavioral model does not match verified artifact alias")
    if (behavior.get("inference_base_url") or "").rstrip("/") != serving.get(
        "endpoint"
    ) or not behavior.get("inference_base_url"):
        raise ValueError("behavioral and serving endpoints differ")


def select(registry_path, policy_path, bundle_path, output):
    policy = validate_policy(read(policy_path, "ama_release_policy"))
    entries = json.loads(Path(bundle_path).read_text())
    if not entries or len({e["candidate_id"] for e in entries}) != len(entries):
        raise ValueError("nonempty unique candidate bundle required")
    passed, rejected, lineage = [], [], set()
    registry_snapshot = load_registry(registry_path)
    for entry in entries:
        selected = candidate(entry["candidate_id"], registry_path)
        lineage.add((selected["preset"], selected["dataset_sha256"], selected["split_sha256"]))
        try:
            verify_candidate_lineage(
                selected,
                registry_snapshot,
                {key: policy[key] for key in ("selection_dataset_sha256", "final_dataset_sha256")},
            )
            passed.append(check_bundle(entry, selected, policy))
        except (ValueError, KeyError, OSError) as error:
            rejected.append({"candidate_id": selected["candidate_id"], "reason": str(error)})
    if len(lineage) != 1:
        raise ValueError("selection candidates must share preset, corpus and split")
    if not passed:
        raise ValueError(f"no passing candidates: {rejected}")
    comparisons = {
        digest(
            {
                "evaluation_configuration": entry["evaluation_configuration"],
                "call_settings": entry["serving"]["config"]["call_settings"],
                "reasoning_effort": entry["serving"]["config"].get("reasoning_effort"),
            }
        )
        for entry in passed
    }
    if len(comparisons) != 1:
        raise ValueError(
            "passing candidates use mixed evaluation configurations or inference settings"
        )
    passed.sort(
        key=lambda c: (-c["selection_score"], c["selection_nll"], c["step"], c["candidate_id"])
    )
    decision = seal(
        {
            "schema_version": 1,
            "kind": "ama_selection_decision",
            "policy": policy,
            "winner": passed[0],
            "ranking": [
                {k: c[k] for k in ("candidate_id", "selection_score", "selection_nll", "step")}
                for c in passed
            ],
            "rejected": rejected,
        }
    )
    with transaction(registry_path) as registry:
        final_hash = policy["final_dataset_sha256"]
        if final_hash in registry["decisions"]:
            raise ValueError(
                "this frozen final dataset already has a locked decision; no runner-up or reselection"
            )
        registry["decisions"][final_hash] = {"status": "locked", "decision": decision}
        write(output, decision)
    return decision


def claim_final(registry_path, decision_path):
    decision = read(decision_path, "ama_selection_decision")
    attempt_id = str(uuid.uuid4())
    with transaction(registry_path) as registry:
        state = registry["decisions"].get(decision["policy"]["final_dataset_sha256"])
        if (
            not state
            or state["decision"]["artifact_sha256"] != decision["artifact_sha256"]
            or state["status"] != "locked"
        ):
            raise ValueError("final evaluation already claimed/consumed or decision changed")
        selected = registry["candidates"].get(decision["winner"]["candidate_id"])
        if not selected or selected["artifact_sha256"] != decision["winner"]["candidate_sha256"]:
            raise ValueError("locked candidate changed before final claim")
        verify_candidate_lineage(
            selected,
            registry,
            {
                key: decision["policy"][key]
                for key in ("selection_dataset_sha256", "final_dataset_sha256")
            },
        )
        state.update(status="final_running", final_attempt_id=attempt_id)
    return attempt_id


def fail_final(registry_path, decision, attempt_id, reason):
    with transaction(registry_path) as registry:
        state = registry["decisions"].get(decision["policy"]["final_dataset_sha256"])
        if (
            state
            and state.get("final_attempt_id") == attempt_id
            and state["status"] == "final_running"
        ):
            state.update(status="final_failed", failure=reason)


def promote(registry_path, decision_path, final_path, final_nll_path):
    decision = read(decision_path, "ama_selection_decision")
    winner, policy = decision["winner"], decision["policy"]
    error = None
    with transaction(registry_path) as registry:
        state = registry["decisions"].get(policy["final_dataset_sha256"])
        if (
            not state
            or state["decision"]["artifact_sha256"] != decision["artifact_sha256"]
            or state["status"] != "final_running"
        ):
            raise ValueError("decision missing, changed, or final evaluation already consumed")
        try:
            final = json.loads(Path(final_path).read_text())
            selected = candidate(winner["candidate_id"], registry_path)
            if selected["artifact_sha256"] != winner["candidate_sha256"]:
                raise ValueError("selected candidate changed after locking")
            verify_candidate_lineage(
                selected,
                registry,
                {key: policy[key] for key in ("selection_dataset_sha256", "final_dataset_sha256")},
            )
            if final.get("final_attempt_id") != state.get("final_attempt_id"):
                raise ValueError("final behavioral attempt does not match the claimed attempt")
            final_nll = read(final_nll_path, "ama_nll")
            if final_nll.get("final_attempt_id") != state.get("final_attempt_id"):
                raise ValueError("final NLL attempt does not match the claimed attempt")
            _bound(final_nll, selected)
            if (
                final_nll.get("partition") != "final"
                or final_nll.get("selection_decision_sha256") != decision["artifact_sha256"]
                or final_nll.get("examples", 0) != selected["partition_counts"]["final"]
                or not isinstance(final_nll.get("nll"), (int, float))
                or not math.isfinite(final_nll["nll"])
                or final_nll["nll"] < 0
            ):
                raise ValueError("finite locked-winner final NLL diagnostic required")
            for field in ("dataset_sha256", "split_sha256", "training_config_sha256"):
                if final_nll.get(field) != selected[field]:
                    raise ValueError("final NLL lineage mismatch")
            score = behavioral(
                final,
                selected,
                policy,
                "final",
                winner["model_artifact_sha256"],
                winner["serving_config_sha256"],
                decision["artifact_sha256"],
            )
            verify_serving_behavior(winner["serving"], final)
            if evaluation_configuration(final) != winner["evaluation_configuration"]:
                raise ValueError(
                    "final prompt/scorer/transport/SDK/judge configuration differs from selection"
                )
        except (ValueError, KeyError, TypeError, OSError, AttributeError) as caught:
            error = str(caught)
            state.update(status="final_failed", failure=error)
        else:
            previous = registry["deployable"].get(winner["preset"])
            pointer = {
                "candidate_id": winner["candidate_id"],
                "checkpoint_path": winner["checkpoint_path"],
                "model_artifact_sha256": winner["model_artifact_sha256"],
                "serving_config_sha256": winner["serving_config_sha256"],
                "selection_decision_sha256": decision["artifact_sha256"],
                "final_report_sha256": final["report_sha256"],
                "final_nll_sha256": final_nll["artifact_sha256"],
                "final_nll": final_nll["nll"],
                "final_score": score,
            }
            registry["history"].append(
                {
                    "action": "promote",
                    "preset": winner["preset"],
                    "previous": previous,
                    "next": pointer,
                }
            )
            registry["deployable"][winner["preset"]] = pointer
            state.update(status="promoted", final_report_sha256=final["report_sha256"])
    if error:
        raise ValueError(
            f"final evaluation failed; stopped without trying another candidate: {error}"
        )
    return pointer


def evaluate_final(
    registry_path, decision_path, training_args_path, output_dir, runner=subprocess.run
):
    """Explicit paid final evaluation, claimed before calls; passing reports auto-promote."""
    registry_path, decision_path = Path(registry_path).resolve(), Path(decision_path).resolve()
    decision = read(decision_path, "ama_selection_decision")
    training_args = json.loads(Path(training_args_path).read_text())
    if not isinstance(training_args, list) or not all(
        isinstance(arg, str) and "=" in arg for arg in training_args
    ):
        raise ValueError(
            "training args file must contain the exact original key=value argument array"
        )
    if any(
        arg.partition("=")[0]
        in {"candidate", "output", "partition", "decision", "registry", "final_attempt"}
        for arg in training_args
    ):
        raise ValueError("training args cannot override final evaluation bindings")
    output = Path(output_dir).resolve()
    output.mkdir(parents=True, exist_ok=False)
    attempt_id = claim_final(registry_path, decision_path)
    winner = decision["winner"]
    repository = Path(__file__).resolve().parents[2]
    behavior_path, nll_path = output / "final-behavior.json", output / "final-nll.json"
    env = os.environ.copy()
    for key in (
        "AMA_EVAL_MODEL",
        "AMA_EVAL_PROVIDERS",
        "AMA_EVAL_MAX_OUTPUT_TOKENS",
        "AMA_EVAL_SELECTION_REPORT",
    ):
        env.pop(key, None)
    env.update(
        {
            "AMA_EVAL_PROFILE": "production",
            "AMA_EVAL_SUITE": "final",
            "AMA_EVAL_COMMAND": "suite",
            "AMA_EVAL_REQUIRE_BINDINGS": "1",
            "AMA_EVAL_USE_JUDGE": "1",
            "AMA_EVAL_CANDIDATE_ID": winner["candidate_id"],
            "AMA_EVAL_CHECKPOINT_PATH": winner["checkpoint_path"],
            "AMA_EVAL_MODEL_ARTIFACT_SHA256": winner["model_artifact_sha256"],
            "AMA_EVAL_SERVING_CONFIG_SHA256": winner["serving_config_sha256"],
            "AMA_EVAL_SELECTION_DECISION_SHA256": decision["artifact_sha256"],
            "AMA_EVAL_FINAL_ATTEMPT_ID": attempt_id,
            "AMA_EVAL_OUTPUT_PATH": str(behavior_path),
            "AMA_INFERENCE_BASE_URL": winner["serving"]["endpoint"],
            "AMA_DEPLOYMENT_MODEL": winner["serving"]["model"],
            "AMA_MAX_OUTPUT_TOKENS": str(
                winner["serving"]["config"]["call_settings"]["maxOutputTokens"]
            ),
        }
    )
    judge = winner["evaluation_configuration"]["judgeModelConfig"]
    env["AMA_EVAL_JUDGE_MODEL"] = judge["model"]
    providers = judge.get("providerOptions", {}).get("gateway", {}).get("order", [])
    env["AMA_EVAL_JUDGE_PROVIDERS"] = ",".join(providers)
    effort = winner["serving"]["config"].get("reasoning_effort")
    if effort is None:
        env.pop("AMA_INFERENCE_REASONING_EFFORT", None)
    else:
        env["AMA_INFERENCE_REASONING_EFFORT"] = str(effort)
    try:
        runner(
            ["pnpm", "exec", "vitest", "run", "--config", "vitest.eval.config.ts"],
            cwd=repository / "frontend",
            env=env,
            check=True,
        )
        runner(
            [
                sys.executable,
                "-m",
                "ama_training.score",
                f"candidate={winner['candidate_id']}",
                "partition=final",
                f"decision={decision_path}",
                f"registry={registry_path}",
                f"final_attempt={attempt_id}",
                f"output={nll_path}",
                *training_args,
            ],
            cwd=repository / "training",
            env=env,
            check=True,
        )
        return promote(registry_path, decision_path, behavior_path, nll_path)
    except BaseException as error:
        fail_final(registry_path, decision, attempt_id, type(error).__name__)
        raise


def rollback(registry_path, preset):
    with transaction(registry_path) as registry:
        current = registry["deployable"].get(preset)
        prior = next(
            (
                h["previous"]
                for h in reversed(registry["history"])
                if h["action"] == "promote" and h["preset"] == preset and h["next"] == current
            ),
            None,
        )
        if not prior:
            raise ValueError("no previous deployable candidate to roll back to")
        registry["history"].append(
            {"action": "rollback", "preset": preset, "previous": current, "next": prior}
        )
        registry["deployable"][preset] = prior
    return prior


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--registry", default=str(DEFAULT_REGISTRY))
    commands = parser.add_subparsers(dest="command", required=True)
    selection = commands.add_parser("select")
    for name in ("policy", "bundle", "out"):
        selection.add_argument(f"--{name}", required=True)
    promotion = commands.add_parser("promote")
    promotion.add_argument("--decision", required=True)
    promotion.add_argument("--final", required=True)
    promotion.add_argument("--final-nll", required=True)
    evaluation = commands.add_parser("evaluate-final")
    for name in ("decision", "training-args", "out"):
        evaluation.add_argument(f"--{name}", required=True)
    previous = commands.add_parser("rollback")
    previous.add_argument("--preset", required=True)
    args = parser.parse_args()
    if args.command == "select":
        result = select(args.registry, args.policy, args.bundle, args.out)
    elif args.command == "evaluate-final":
        result = evaluate_final(args.registry, args.decision, args.training_args, args.out)
    elif args.command == "promote":
        result = promote(args.registry, args.decision, args.final, args.final_nll)
    else:
        result = rollback(args.registry, args.preset)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
