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
from tinker_cookbook import cli_utils
from tinker_cookbook.renderers import TrainOnWhat
from tinker_cookbook.supervised import train
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig

from ama_training.dataset import AmaTraceDatasetBuilder

TRAINING_DIR = Path(__file__).resolve().parents[1]
EXPORT_DIR = TRAINING_DIR / "data" / "export"

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


def build_blueprint(preset_name: str) -> chz.Blueprint[train.Config]:
    preset = PRESETS[preset_name]
    builder = AmaTraceDatasetBuilder(
        file_path=str(EXPORT_DIR / preset["file"]),
        manifest_path=str(EXPORT_DIR / "prompt-manifest.json"),
        test_size=50,
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
            "dataset_builder": builder,
            **DEFAULT_HYPERPARAMS,
        }
    )


def main(argv: list[str]) -> None:
    preset_name = "qwen3.5-4b"
    overrides = []
    for arg in argv:
        if arg.startswith("preset="):
            preset_name = arg.split("=", 1)[1]
        else:
            overrides.append(arg)
    if preset_name not in PRESETS:
        raise SystemExit(f"unknown preset {preset_name!r}; choose from {sorted(PRESETS)}")

    config = build_blueprint(preset_name).apply_from_argv(overrides).make()
    cli_utils.check_log_dir(config.log_path, behavior_if_exists="ask")
    asyncio.run(train.main(config))


if __name__ == "__main__":
    main(sys.argv[1:])
