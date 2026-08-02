"""Offline validation of a preset's dataset construction — no Tinker API key.

Renders real export rows through the preset's renderer and reports token
statistics, masked-token counts, and a decoded sample of the trained region.
Run before any training run:

    uv run python -m ama_training.validate preset=qwen3.5-4b limit=100
"""

import sys

from tinker_cookbook.renderers import TrainOnWhat

from ama_training.train import PRESETS, build_blueprint


def main(argv: list[str]) -> None:
    preset_name = "qwen3.5-4b"
    limit = 100
    for arg in argv:
        if arg.startswith("preset="):
            preset_name = arg.split("=", 1)[1]
        elif arg.startswith("limit="):
            limit = int(arg.split("=", 1)[1])
        else:
            raise SystemExit(f"unknown arg {arg!r}")
    if preset_name not in PRESETS:
        raise SystemExit(f"unknown preset {preset_name!r}; choose from {sorted(PRESETS)}")

    config = build_blueprint(preset_name).make()
    builder = config.dataset_builder
    train_dataset, test_dataset = builder()
    renderer = builder.renderer
    tokenizer = builder.tokenizer
    common = builder.common_config
    train_on_what = TrainOnWhat(common.train_on_what)

    conversations = train_dataset.conversations + (
        test_dataset.conversations if test_dataset else []
    )
    print(f"preset={preset_name} renderer={common.renderer_name} "
          f"train_on_what={train_on_what.value}")
    print(f"train={len(train_dataset.conversations)} "
          f"test={len(test_dataset.conversations) if test_dataset else 0} "
          f"(rendering {min(limit, len(conversations))} of {len(conversations)})")

    lengths: list[int] = []
    weighted: list[int] = []
    over_max = 0
    sample_decoded: str | None = None
    for conversation in conversations[:limit]:
        model_input, weights = renderer.build_supervised_example(
            conversation, train_on_what=train_on_what
        )
        n_tokens = model_input.length
        lengths.append(n_tokens)
        n_weighted = int((weights > 0).sum().item())
        weighted.append(n_weighted)
        if n_weighted == 0:
            raise SystemExit("example with zero trained tokens — masking is broken")
        if common.max_length is not None and n_tokens > common.max_length:
            over_max += 1
        if sample_decoded is None:
            tokens = model_input.to_ints()
            trained = [t for t, w in zip(tokens, weights.tolist()) if w > 0]
            sample_decoded = tokenizer.decode(trained)

    lengths.sort()
    p = lambda q: lengths[int(q * (len(lengths) - 1))]
    print(f"tokens/example: min={lengths[0]} p50={p(0.5)} p95={p(0.95)} max={lengths[-1]}")
    print(f"trained tokens/example: mean={sum(weighted) / len(weighted):.0f}")
    print(f"examples over max_length={common.max_length}: {over_max}")
    print("\n--- decoded trained region of first example ---")
    print(sample_decoded[:2000])
    if over_max:
        raise SystemExit(
            f"{over_max} examples exceed max_length={common.max_length}; "
            "right-truncation would destroy their training targets. "
            "Raise max_length or re-export."
        )


if __name__ == "__main__":
    main(sys.argv[1:])
