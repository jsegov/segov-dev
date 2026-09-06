"""Keep original warm-start provenance while registry progress advances, entirely offline."""

import json
from types import SimpleNamespace

import pytest
import tinker

from ama_training import sample, score, train, validate
from ama_training.provenance import read, seal, write
from ama_training.registry import candidate, load_registry, transaction
from ama_training.split import make_split


@pytest.fixture
def warm_runs(verified_export, tmp_path, monkeypatch):
    root = verified_export
    registry = tmp_path / "registry.json"
    monkeypatch.setattr(train, "CHECKPOINT_REGISTRY", registry)
    make_split(root / "dataset-manifest.json", root / "split-manifest.json")
    common = [
        "preset=qwen3.5-4b",
        f"dataset_builder.file_path={root / 'ama-traces-qwen.jsonl'}",
        f"dataset_builder.manifest_path={root / 'prompt-manifest.json'}",
        f"dataset_builder.dataset_manifest_path={root / 'dataset-manifest.json'}",
        f"dataset_builder.split_manifest_path={root / 'split-manifest.json'}",
    ]
    calls = []

    async def train_without_network(config):
        calls.append(config)
        name = config.log_path.rsplit("/", 1)[-1]
        path = tmp_path / name / "checkpoints.jsonl"
        path.write_text(
            json.dumps(
                {
                    "state_path": f"tinker://{name}/weights/final",
                    "sampler_path": f"tinker://{name}/sampler_weights/final",
                    "batch": 10,
                }
            )
            + "\n"
        )

    monkeypatch.setattr(train.train, "main", train_without_network)
    args = {name: [*common, f"log_path={tmp_path / name}"] for name in ("base", "child", "next")}
    train.main(args["base"])
    train.main(args["child"])
    candidates = {
        value["state_path"].split("/")[2]: value
        for value in load_registry(registry)["candidates"].values()
    }
    assert candidates["base"]["warm_start"] is None
    assert candidates["child"]["warm_start"] == candidates["base"]["state_path"]
    pointer = load_registry(registry)["latest_training_state"]["qwen3.5-4b"]
    assert pointer["state_path"] == candidates["child"]["state_path"]
    return SimpleNamespace(
        root=root, registry=registry, args=args, candidates=candidates, calls=calls
    )


@pytest.mark.parametrize("name", ["base", "child"])
@pytest.mark.parametrize("partition", ["selection", "final"])
def test_candidate_score_and_sample_reuse_original_arguments_after_registration(
    warm_runs, name, partition, tmp_path, monkeypatch
):
    runs = warm_runs
    selected = runs.candidates[name]
    state_paths, sampler_paths = [], []
    _, config = train.resolve_config(
        runs.args[name], candidate_id=selected["candidate_id"], registry_path=runs.registry
    )
    tokens = config.dataset_builder.tokenizer.encode("Hello!<|im_end|>")

    class Client:
        async def forward_async(self, data, *, loss_fn):
            assert loss_fn == "cross_entropy" and len(data) == 2

            async def result():
                return SimpleNamespace(
                    loss_fn_outputs=[
                        {
                            "logprobs": tinker.TensorData(
                                data=[-1.25] * len(datum.loss_fn_inputs["weights"].data),
                                dtype="float32",
                                shape=[len(datum.loss_fn_inputs["weights"].data)],
                            )
                        }
                        for datum in data
                    ]
                )

            return SimpleNamespace(result_async=result)

        async def sample_async(self, *args, **kwargs):
            return SimpleNamespace(sequences=[SimpleNamespace(tokens=tokens)])

    class OfflineService:
        async def create_training_client_from_state_async(self, state_path):
            state_paths.append(state_path)
            return Client()

        def create_sampling_client(self, *, model_path):
            sampler_paths.append(model_path)
            return Client()

    monkeypatch.setattr(tinker, "ServiceClient", OfflineService)
    fixtures = sample.load_fixtures()
    fixtures["fixtures"] = [f for f in fixtures["fixtures"] if f["id"] == "greeting"]
    monkeypatch.setattr(sample, "load_fixtures", lambda: fixtures)
    nll_path, smoke_path = tmp_path / "nll.json", tmp_path / "smoke.json"
    bindings = [f"candidate={selected['candidate_id']}", f"registry={runs.registry}"]
    final_bindings = []
    if partition == "final":
        # Seed the same locked-winner/claimed-attempt state required by score;
        # release gate behavior is covered separately, without any final model call.
        decision = seal(
            {
                "schema_version": 1,
                "kind": "ama_selection_decision",
                "policy": {
                    "final_dataset_sha256": selected["evaluation_datasets"]["final_dataset_sha256"]
                },
                "winner": {"candidate_id": selected["candidate_id"]},
            }
        )
        decision_path = tmp_path / "decision.json"
        write(decision_path, decision)
        with transaction(runs.registry) as registry:
            registry["decisions"][decision["policy"]["final_dataset_sha256"]] = {
                "status": "final_running",
                "final_attempt_id": "offline-attempt",
                "decision": decision,
            }
        final_bindings = [f"decision={decision_path}", "final_attempt=offline-attempt"]
    score.main(
        [
            *bindings,
            f"output={nll_path}",
            f"partition={partition}",
            *final_bindings,
            *runs.args[name],
        ]
    )
    sample.main([*bindings, f"output={smoke_path}", "prompt_version=all", *runs.args[name]])
    nll, smoke = read(nll_path, "ama_nll"), read(smoke_path, "ama_smoke")
    assert nll["nll"] == pytest.approx(1.25)
    assert nll["partition"] == partition
    assert nll["training_config_sha256"] == selected["training_config_sha256"]
    assert smoke["training_config_sha256"] == selected["training_config_sha256"]
    assert state_paths == [selected["state_path"]]
    assert sampler_paths == [selected["checkpoint_path"]]
    assert smoke["prompt_versions"] == ["v1", "v2"]
    assert all(result["passed"] for result in smoke["results"])


def test_same_run_resume_preserves_parent_and_new_run_reads_latest(warm_runs):
    runs = warm_runs
    before = candidate(runs.candidates["child"]["candidate_id"], runs.registry)
    train.main(runs.args["child"])
    assert runs.calls[-1].load_checkpoint_path == runs.candidates["base"]["state_path"]
    assert candidate(before["candidate_id"], runs.registry) == before
    # The original default-warm-start base run remains a base run, too.
    _, base = train.resolve_config(runs.args["base"], resume=True)
    assert base.load_checkpoint_path is None
    train.main(runs.args["next"])
    assert runs.calls[-1].load_checkpoint_path == before["state_path"]


@pytest.mark.parametrize("name", ["base", "child"])
def test_validate_uses_the_same_saved_run_parent_as_training(warm_runs, name, tmp_path):
    runs = warm_runs
    output = tmp_path / "validated.json"
    report = validate.main([*runs.args[name], f"output={output}"])
    assert report["artifact_sha256"] == runs.candidates[name]["preflight_sha256"]
    original_parent = runs.candidates[name]["warm_start"]
    assert (
        read(output, "ama_preflight")["training_config"]["load_checkpoint_path"] == original_parent
    )


@pytest.mark.parametrize(
    "option", ["warm_start=false", "warm_start_from=OTHER", "load_checkpoint_path=OTHER"]
)
@pytest.mark.parametrize("context", ["candidate", "resume"])
def test_explicit_conflicting_checkpoint_is_rejected(warm_runs, option, context):
    runs = warm_runs
    kwargs = (
        {"candidate_id": runs.candidates["child"]["candidate_id"], "registry_path": runs.registry}
        if context == "candidate"
        else {"resume": True}
    )
    with pytest.raises(ValueError, match="explicit warm-start setting differs"):
        train.resolve_config([*runs.args["child"], option], **kwargs)


def test_explicit_matching_parent_and_other_config_mismatches_remain_checked(
    warm_runs, monkeypatch, tmp_path
):
    runs = warm_runs
    selected = runs.candidates["child"]
    _, config = train.resolve_config(
        [*runs.args["child"], f"warm_start_from={selected['warm_start']}"],
        candidate_id=selected["candidate_id"],
        registry_path=runs.registry,
    )
    assert config.load_checkpoint_path == selected["warm_start"]

    def no_service():
        pytest.fail("invalid configuration reached Tinker")

    monkeypatch.setattr(tinker, "ServiceClient", no_service)
    with pytest.raises(ValueError, match="differ from training preflight"):
        score.main(
            [
                f"candidate={selected['candidate_id']}",
                f"registry={runs.registry}",
                f"output={tmp_path / 'invalid.json'}",
                *runs.args["child"],
                "learning_rate=1e-5",
            ]
        )


@pytest.mark.parametrize("damage", ["missing", "inconsistent"])
def test_resume_rejects_missing_or_inconsistent_run_provenance(warm_runs, damage):
    runs = warm_runs
    path = runs.root.parent / "child" / "run-manifest.json"
    if damage == "missing":
        path.unlink()
    else:
        manifest = read(path, "ama_run")
        manifest.pop("artifact_sha256")
        manifest["warm_start"] = "tinker://other/weights/final"
        write(path, seal(manifest))
    with pytest.raises(ValueError, match=f"existing run has {damage} provenance"):
        train.main(runs.args["child"])
    assert len(runs.calls) == 2
