"""Train an AMA adapter on Tinker.

Usage (from training/):

    TINKER_API_KEY=... uv run python -m ama_training.train preset=qwen3.5-4b
    TINKER_API_KEY=... uv run python -m ama_training.train preset=inkling-small

Any tinker_cookbook train.Config field can be overridden as key=value, e.g.:

    uv run python -m ama_training.train preset=qwen3.5-4b learning_rate=1e-4 num_epochs=1

Presets encode the per-model table in docs/ama-fine-tuning-experiment.md:
renderer, export construction, and masking are one decision made together —
the collapsed export trains every assistant message (valid because tml_v0
renders history identically at train and inference time), while the per-turn
export trains only the last assistant turn (because qwen renderers rewrite
thinking in history). Adding a future model means adding a preset here after
checking which construction its renderer supports.
"""

import asyncio
import sys
from pathlib import Path

import chz
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig

from ama_training.dataset import AmaTraceDatasetBuilder

TRAINING_DIR = Path(__file__).resolve().parents[1]
EXPORT_DIR = TRAINING_DIR / "data" / "export"

from ama_training.registry import (
    DEFAULT_REGISTRY,
    load_registry,
    register_checkpoints,
    resolve_parent,
)
from ama_training.preflight import run_preflight
from ama_training.provenance import read, write, seal

CHECKPOINT_REGISTRY = DEFAULT_REGISTRY


def registered_checkpoint(preset_name: str) -> str | None:
    entry = load_registry(CHECKPOINT_REGISTRY)["latest_training_state"].get(preset_name)
    return entry.get("state_path") if entry else None


PRESETS: dict[str, dict] = {
    # Stage 1: collapsed one-example-per-conversation export. tml_v0 has the
    # extension property, so every assistant message can take loss exactly once.
    "inkling-small": {
        "model_name": "thinkingmachines/Inkling-Small",
        "renderer_name": "tml_v0",
        "file": "ama-traces-inkling.jsonl",
        "train_on_what": TrainOnWhat.ALL_ASSISTANT_MESSAGES,
    },
    # Stage 2: per-turn export, prefix weight-0. qwen3_5 renderers rewrite
    # thinking in history, so whole-conversation examples would train early
    # turns against a prefix the model never sees at inference.
    "qwen3.5-4b": {
        "model_name": "Qwen/Qwen3.5-4B",
        "renderer_name": "qwen3_5_disable_thinking",
        "file": "ama-traces-qwen.jsonl",
        "train_on_what": TrainOnWhat.LAST_ASSISTANT_TURN,
    },
}

# Starting points from the Tinker sft_sweep results for Qwen3.5-4B (LR optimum
# 3e-4, rank >= 16 within noise of 128; batch 64 keeps enough steps on a small
# corpus). No published sweep exists for Inkling-Small — same starting point,
# but watch held-out NLL closely.
DEFAULT_HYPERPARAMS = {
    "learning_rate": 3e-4,
    "lr_schedule": "linear",
    "num_epochs": 3,
    "lora_rank": 32,
    "eval_every": 5,
    "save_every": 10,
}


def build_blueprint(
    preset_name: str, load_checkpoint_path: str | None = None
) -> chz.Blueprint[train.Config]:
    preset = PRESETS[preset_name]
    builder = AmaTraceDatasetBuilder(
        file_path=str(EXPORT_DIR / preset["file"]),
        manifest_path=str(EXPORT_DIR / "prompt-manifest.json"),
        dataset_manifest_path=str(EXPORT_DIR / "dataset-manifest.json"),
        split_manifest_path=str(EXPORT_DIR / "split-manifest.json"),
        common_config=ChatDatasetBuilderCommonConfig(
            model_name_for_tokenizer=preset["model_name"],
            renderer_name=preset["renderer_name"],
            # Right-truncation destroys the targets (they end the sequence), so
            # this must cover the longest rendered example; ama_training.validate
            # fails if any example exceeds it. Corpus max observed: ~26K tokens.
            max_length=32768,
            batch_size=64,
            train_on_what=preset["train_on_what"],
        ),
    )
    return chz.Blueprint(train.Config).apply(
        {
            "log_path": str(TRAINING_DIR / "logs" / f"ama-{preset_name}"),
            "model_name": preset["model_name"],
            "recipe_name": "ama_sft",
            "renderer_name": preset["renderer_name"],
            "load_checkpoint_path": load_checkpoint_path,
            "dataset_builder": AmaTraceDatasetBuilder,
            "dataset_builder.common_config": ChatDatasetBuilderCommonConfig,
            **{
                f"dataset_builder.{key}": value
                for key, value in chz.asdict(builder).items()
                if key != "common_config"
            },
            **{
                f"dataset_builder.common_config.{key}": value
                for key, value in chz.asdict(builder.common_config).items()
            },
            **DEFAULT_HYPERPARAMS,
        }
    )


def resolve_config(argv: list[str]):
    preset_name = "qwen3.5-4b"
    warm_start = True
    warm_start_from = None
    overrides = []
    for arg in argv:
        if arg.startswith("preset="):
            preset_name = arg.split("=", 1)[1]
        elif arg.startswith("warm_start="):
            warm_start = arg.split("=", 1)[1].lower() not in {"false", "0", "no"}
        elif arg.startswith("warm_start_from="):
            warm_start_from = arg.split("=", 1)[1]
        else:
            overrides.append(arg)
    if preset_name not in PRESETS:
        raise ValueError(f"unknown preset {preset_name!r}")
    checkpoint = warm_start_from or (registered_checkpoint(preset_name) if warm_start else None)
    config = build_blueprint(preset_name, checkpoint).apply_from_argv(overrides).make()
    return preset_name, config


def main(argv: list[str]) -> None:
    preset_name, config = resolve_config(argv)
    # Resolve overrides once; validate all rows, render every train/selection datum before network work.
    preflight = run_preflight(config)
    resolve_parent(
        config.load_checkpoint_path, preset_name, preflight, load_registry(CHECKPOINT_REGISTRY)
    )
    log_path = Path(config.log_path)
    prior = log_path / "preflight.json"
    if log_path.exists() and any(log_path.iterdir()):
        if (
            not prior.exists()
            or read(prior, "ama_preflight")["artifact_sha256"] != preflight["artifact_sha256"]
        ):
            raise ValueError(
                "existing run has different or missing provenance; choose a new log_path"
            )
    log_path.mkdir(parents=True, exist_ok=True)
    write(prior, preflight)
    write(
        log_path / "run-manifest.json",
        seal(
            {
                "schema_version": 1,
                "kind": "ama_run",
                "preset": preset_name,
                "preflight_sha256": preflight["artifact_sha256"],
                "dataset_sha256": preflight["dataset_sha256"],
                "split_sha256": preflight["split_sha256"],
                "training_config_sha256": preflight["training_config_sha256"],
                "warm_start": config.load_checkpoint_path,
            }
        ),
    )
    asyncio.run(train.main(config))
    candidates = register_checkpoints(
        preset_name, config.log_path, preflight, config.load_checkpoint_path, CHECKPOINT_REGISTRY
    )
    print(
        f"Recorded {len(candidates)} checkpoint candidates; deployable pointer requires release checks."
    )


if __name__ == "__main__":
    main(sys.argv[1:])
