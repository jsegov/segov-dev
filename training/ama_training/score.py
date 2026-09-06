"""Explicit Tinker NLL evaluation of a registered candidate on the selection split."""
import asyncio
import sys
import tinker
from tinker_cookbook.supervised.nll_evaluator import NLLEvaluator
from ama_training.registry import DEFAULT_REGISTRY, candidate
from ama_training.train import resolve_config
from ama_training.preflight import run_preflight
from ama_training.provenance import read, seal, write
from ama_training.dataset import InMemorySupervisedDataset
from ama_training.registry import load_registry


async def run(
    candidate_id,
    config,
    output,
    partition="selection",
    decision_path=None,
    registry_path=DEFAULT_REGISTRY,
    final_attempt=None,
):
    selected = candidate(candidate_id, registry_path)
    preflight = run_preflight(config)
    if selected["preflight_sha256"] != preflight["artifact_sha256"]:
        raise ValueError("scoring code/dependencies/data differ from training preflight")
    for key in ("dataset_sha256", "split_sha256", "training_config_sha256"):
        if selected[key] != preflight[key]:
            raise ValueError(f"candidate {key} differs from scoring configuration")
    decision = None
    if partition == "final":
        if not decision_path:
            raise ValueError("final NLL requires the locked selection decision")
        decision = read(decision_path, "ama_selection_decision")
        state = load_registry(registry_path)["decisions"].get(
            decision["policy"]["final_dataset_sha256"]
        )
        if (
            not state
            or state["status"] != "final_running"
            or state.get("final_attempt_id") != final_attempt
            or state["decision"]["artifact_sha256"] != decision["artifact_sha256"]
            or decision["winner"]["candidate_id"] != candidate_id
        ):
            raise ValueError("final NLL is limited to the locked winner")
        builder = config.dataset_builder
        conversations = [
            conversation
            for _, part, conversation in builder.conversations_with_metadata()
            if part == "final"
        ]
        for conversation in conversations:
            model_input, weights = builder.render(conversation)
            if model_input.length > builder.common_config.max_length:
                raise ValueError(
                    "frozen final example exceeds trained context length; stop without tuning against final"
                )
            if not weights[1:].sum().item() > 0:
                raise ValueError("frozen final example has no shifted targets")
        dataset = InMemorySupervisedDataset(conversations, len(conversations), builder.to_datum)
    elif partition == "selection":
        _, dataset = config.dataset_builder()
    else:
        raise ValueError("NLL partition must be selection or final")
    evaluator = NLLEvaluator.from_dataset(dataset, name=partition)
    service = tinker.ServiceClient()
    client = await service.create_training_client_from_state_async(selected["state_path"])
    metrics = await evaluator(client)
    report = seal(
        {
            "schema_version": 1,
            "kind": "ama_nll",
            "candidate_id": candidate_id,
            "checkpoint_path": selected["checkpoint_path"],
            "dataset_sha256": selected["dataset_sha256"],
            "split_sha256": selected["split_sha256"],
            "training_config_sha256": selected["training_config_sha256"],
            "partition": partition,
            "final_attempt_id": final_attempt,
            "selection_decision_sha256": decision["artifact_sha256"] if decision else None,
            "examples": len(dataset.conversations),
            "nll": metrics[f"{partition}/nll"],
        }
    )
    write(output, report)
    return report


def main(argv):
    own, args = {}, []
    for arg in argv:
        key, _, value = arg.partition("=")
        if key in ("candidate", "output", "partition", "decision", "registry", "final_attempt"):
            own[key] = value
        else:
            args.append(arg)
    if not {"candidate", "output"}.issubset(own):
        raise ValueError(
            "candidate= and output= required, followed by the actual training overrides"
        )
    _, config = resolve_config(args)
    asyncio.run(
        run(
            own["candidate"],
            config,
            own["output"],
            own.get("partition", "selection"),
            own.get("decision"),
            own.get("registry", DEFAULT_REGISTRY),
            own.get("final_attempt"),
        )
    )


if __name__ == "__main__":
    main(sys.argv[1:])
