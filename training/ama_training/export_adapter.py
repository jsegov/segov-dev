"""Explicit candidate/checkpoint export; Qwen serving defaults to a merged artifact.

No latest-training pointer is implicitly exported. The local manifest binds every
model file to the exact candidate and sampler checkpoint for serving verification.
"""

import json
import os
import sys
import shutil
import time
from pathlib import Path

# Tinker's async telemetry sender can enter a retry storm (observed: 422 on a
# malformed session_id) that starves the asyncio loop the checkpoint download
# awaits on — hanging the export at 0% CPU indefinitely. Telemetry adds nothing
# to a one-shot batch export, so default it off (still overridable in the env).
os.environ.setdefault("TINKER_TELEMETRY", "0")

from tinker_cookbook import weights  # noqa: E402 — must follow the env default above

from ama_training.train import PRESETS, TRAINING_DIR
from ama_training.registry import candidate as get_candidate
from ama_training.provenance import file_hash, seal, write

DEFAULT_OUTPUT_DIR = TRAINING_DIR / "data" / "adapters"

# Tinker builds the downloadable archive server-side on first request, and that
# build can take several minutes and time out the client before it finishes.
# Each attempt advances (and eventually caches) the build, so a bounded retry
# turns the flaky first-build into a reliable export. Observed: 2-3 attempts.
DOWNLOAD_ATTEMPTS = 5
DOWNLOAD_BACKOFF_S = 20


def resolve_checkpoint(
    preset_name: str, explicit: str | None, candidate_id: str | None = None
) -> str:
    if candidate_id:
        selected = get_candidate(candidate_id)
        if selected["preset"] != preset_name or (
            explicit and explicit != selected["checkpoint_path"]
        ):
            raise ValueError("candidate preset/checkpoint mismatch")
        explicit = selected["checkpoint_path"]
    if not explicit or "/sampler_weights/" not in explicit:
        raise ValueError(
            "explicit candidate= or checkpoint=tinker://.../sampler_weights/... required"
        )
    return explicit


def artifact_manifest(output_dir, preset_name, checkpoint, candidate_id, merged):
    output_dir = Path(output_dir)
    files = {
        str(file.relative_to(output_dir)): file_hash(file)
        for file in sorted(output_dir.rglob("*"))
        if file.is_file() and file.name != "artifact-manifest.json"
    }
    if not files or not any(name.endswith(".safetensors") for name in files):
        raise ValueError("export contains no model weights")
    manifest = seal(
        {
            "schema_version": 1,
            "kind": "ama_model_artifact",
            "candidate_id": candidate_id,
            "checkpoint_path": checkpoint,
            "preset": preset_name,
            "base_model": PRESETS[preset_name]["model_name"],
            "format": "merged" if merged else "lora",
            "files": files,
        }
    )
    write(output_dir / "artifact-manifest.json", manifest)
    return manifest


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
    merged = True
    candidate_id = None
    for arg in argv:
        key, _, value = arg.partition("=")
        if key == "preset":
            preset_name = value
        elif key == "candidate":
            candidate_id = value
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
    sampler_path = resolve_checkpoint(preset_name, checkpoint, candidate_id)
    output_dir = Path(output) if output else DEFAULT_OUTPUT_DIR / preset_name
    if output_dir.exists():
        raise ValueError("output already exists; use a new immutable artifact directory")
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
        print(f"[serve] vllm serve {base_model} --enable-lora " f"--lora-modules ama={output_dir}")

    # HF download metadata is not model input and may mutate during later loads.
    shutil.rmtree(output_dir / ".cache", ignore_errors=True)
    manifest = artifact_manifest(output_dir, preset_name, sampler_path, candidate_id, merged)
    print(f"[artifact] {manifest['artifact_sha256']}")


if __name__ == "__main__":
    main(sys.argv[1:])
