"""Export a trained Tinker checkpoint to a servable artifact (Stage 2).

Produces the artifact that Modal + vLLM serves: the base model stays frozen and
our fine-tuned LoRA rides on top via ``--lora-modules`` — so what gets served is
*our* checkpoint, never base Qwen.

    TINKER_API_KEY=... uv run python -m ama_training.export_adapter \
        preset=qwen3.5-4b [checkpoint=tinker://.../sampler_weights/final] \
        [output=data/adapters/qwen3.5-4b] [merged=false]

Default (``merged=false``): a ~150 MB PEFT LoRA adapter (``adapter_config.json``
+ ``adapter_model.safetensors``) for ``vllm serve <base> --lora-modules``.
``merged=true``: the fallback — merge into base and emit a standalone ~9.3 GB HF
model, for when the LoRA-target-module coverage gate below can't be satisfied.

CHECKPOINT PATH GOTCHA: export requires a ``sampler_weights/`` path
(``save_weights_for_sampler`` output — weights only). The checkpoint registry
stores the ``weights/`` STATE path (weights + optimizer, for warm-start resume),
which is NOT exportable. With no explicit ``checkpoint=``, this script derives
the ``sampler_weights`` sibling from the registry and tells you what it resolved.
If that sibling was never written for the run, ``download`` fails — mint one by
creating a training client from the state and calling ``save_weights_for_sampler``.

Post-export, verify the LoRA-target-module coverage gate before trusting a
serve: vLLM WARNS-AND-IGNORES adapter module names it doesn't recognize (silent
quality loss — the model drifts toward base), so diff the printed target_modules
against the vLLM startup log and set ``--max-lora-rank`` to the printed rank.
"""

import json
import os
import sys
import time
from pathlib import Path

# Tinker's async telemetry sender can enter a retry storm (observed: 422 on a
# malformed session_id) that starves the asyncio loop the checkpoint download
# awaits on — hanging the export at 0% CPU indefinitely. Telemetry adds nothing
# to a one-shot batch export, so default it off (still overridable in the env).
os.environ.setdefault("TINKER_TELEMETRY", "0")

from tinker_cookbook import weights  # noqa: E402 — must follow the env default above

from ama_training.train import PRESETS, TRAINING_DIR, load_registry

DEFAULT_OUTPUT_DIR = TRAINING_DIR / "data" / "adapters"

# Tinker builds the downloadable archive server-side on first request, and that
# build can take several minutes and time out the client before it finishes.
# Each attempt advances (and eventually caches) the build, so a bounded retry
# turns the flaky first-build into a reliable export. Observed: 2-3 attempts.
DOWNLOAD_ATTEMPTS = 5
DOWNLOAD_BACKOFF_S = 20


def resolve_checkpoint(preset_name: str, explicit: str | None) -> str:
    """Return a sampler_weights checkpoint path to export from.

    An explicit path wins. Otherwise derive the sampler sibling of the
    registry's state path (``.../weights/final`` -> ``.../sampler_weights/final``).
    """
    if explicit:
        return explicit
    entry = load_registry().get(preset_name)
    if not entry or not entry.get("state_path"):
        raise SystemExit(
            f"no registry entry for {preset_name!r} and no checkpoint= given; "
            "pass checkpoint=tinker://.../sampler_weights/final explicitly."
        )
    state_path = entry["state_path"]
    if "/sampler_weights/" in state_path:
        return state_path
    if "/weights/" not in state_path:
        raise SystemExit(
            f"registry state_path {state_path!r} has no '/weights/' segment to "
            "rewrite; pass checkpoint=tinker://.../sampler_weights/... explicitly."
        )
    sampler = state_path.replace("/weights/", "/sampler_weights/")
    print(
        f"[resolve] registry state path: {state_path}\n"
        f"[resolve] exporting from sampler sibling: {sampler}\n"
        "[resolve] (state paths are not exportable; if this sampler checkpoint "
        "was never written, download will fail — mint one with "
        "save_weights_for_sampler.)"
    )
    return sampler


def summarize_adapter(peft_dir: Path) -> None:
    """Print the PEFT adapter_config so the target-module gate is visible."""
    config_path = peft_dir / "adapter_config.json"
    if not config_path.exists():
        print(f"[warn] no adapter_config.json in {peft_dir}")
        return
    config = json.loads(config_path.read_text())
    modules = config.get("target_modules")
    module_list = sorted(modules) if isinstance(modules, (list, set)) else modules
    print(
        "[adapter] base_model_name_or_path="
        f"{config.get('base_model_name_or_path')} r={config.get('r')} "
        f"lora_alpha={config.get('lora_alpha')}"
    )
    print(f"[adapter] target_modules={module_list}")
    print(
        f"[gate] serve with --max-lora-rank {config.get('r')} and confirm vLLM's "
        "startup log does NOT report any of these target_modules as ignored/"
        "unsupported (ignored modules = adapter deltas silently dropped)."
    )


def main(argv: list[str]) -> None:
    preset_name = "qwen3.5-4b"
    checkpoint: str | None = None
    output: str | None = None
    merged = False
    for arg in argv:
        key, _, value = arg.partition("=")
        if key == "preset":
            preset_name = value
        elif key == "checkpoint":
            checkpoint = value
        elif key == "output":
            output = value
        elif key == "merged":
            merged = value.strip().lower() in {"true", "1", "yes"}
        else:
            raise SystemExit(f"unknown arg {arg!r}")
    if preset_name not in PRESETS:
        raise SystemExit(f"unknown preset {preset_name!r}; choose from {sorted(PRESETS)}")

    base_model = PRESETS[preset_name]["model_name"]
    sampler_path = resolve_checkpoint(preset_name, checkpoint)
    output_dir = Path(output) if output else DEFAULT_OUTPUT_DIR / preset_name
    raw_dir = output_dir.parent / f"{output_dir.name}-raw"
    output_dir.parent.mkdir(parents=True, exist_ok=True)

    print(f"[download] {sampler_path} -> {raw_dir}")
    adapter_dir: str | None = None
    last_exc: Exception | None = None
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            adapter_dir = weights.download(tinker_path=sampler_path, output_dir=str(raw_dir))
            break
        except Exception as exc:  # noqa: BLE001 — archive build is flaky; retry
            last_exc = exc
            if attempt < DOWNLOAD_ATTEMPTS:
                print(
                    f"[download] attempt {attempt}/{DOWNLOAD_ATTEMPTS} failed "
                    f"({exc}); the server-side archive build likely isn't ready — "
                    f"retrying in {DOWNLOAD_BACKOFF_S}s (each attempt advances it)."
                )
                time.sleep(DOWNLOAD_BACKOFF_S)
    if adapter_dir is None:
        raise SystemExit(
            f"download failed after {DOWNLOAD_ATTEMPTS} attempts: {last_exc}\n"
            "If this persists, the sampler_weights path may never have been written "
            "for this run. Verify it exists (create_sampling_client on the path), or "
            "mint a fresh one: create a training client from the state checkpoint, "
            "call save_weights_for_sampler, then re-run with checkpoint=tinker://.../"
            "sampler_weights/... ."
        )

    if merged:
        print(f"[build_hf_model] merging into {base_model} -> {output_dir} (~9.3 GB)")
        weights.build_hf_model(
            base_model=base_model, adapter_path=adapter_dir, output_path=str(output_dir)
        )
        print(f"[done] merged HF model at {output_dir}")
        print("[serve] vllm serve <this dir>  (no --enable-lora; it's a standalone model)")
    else:
        print(f"[build_lora_adapter] {base_model} + adapter -> {output_dir} (~150 MB)")
        weights.build_lora_adapter(
            base_model=base_model, adapter_path=adapter_dir, output_path=str(output_dir)
        )
        summarize_adapter(output_dir)
        print(f"[done] PEFT adapter at {output_dir}")
        print(
            f"[serve] vllm serve {base_model} --enable-lora "
            f"--lora-modules ama={output_dir}"
        )


if __name__ == "__main__":
    main(sys.argv[1:])
