"""Verified model and server identities, shared by deployment and release probes."""
import json
from pathlib import Path
from ama_training.provenance import digest, file_hash, read, verify_files

VLLM_VERSION = "0.21.0"
MAX_MODEL_LEN = 32768
MAX_CONCURRENT_INPUTS = 8


def load_model_artifact(model_dir):
    root = Path(model_dir)
    artifact = read(root / "artifact-manifest.json", "ama_model_artifact")
    if (
        artifact.get("format") != "merged"
        or not artifact.get("candidate_id")
        or not artifact.get("checkpoint_path")
    ):
        raise ValueError("serving requires an explicit merged candidate artifact")
    files = artifact.get("files", {})
    if (
        not files
        or "config.json" not in files
        or "tokenizer_config.json" not in files
        or not any(name.endswith(".safetensors") for name in files)
    ):
        raise ValueError("incomplete merged model artifact")
    # Include every actual file: an unlisted shard/tokenizer must not affect loading.
    actual = {
        str(path.relative_to(root))
        for path in root.rglob("*")
        if path.is_file() and path.name != "artifact-manifest.json"
    }
    if actual != set(files):
        raise ValueError("model artifact contains missing or unlisted files")
    verify_files(root, files)
    return artifact


def server_config(artifact, template_path):
    return {
        "model_artifact_sha256": artifact["artifact_sha256"],
        "template_sha256": file_hash(template_path),
        "vllm_version": VLLM_VERSION,
        "max_model_len": MAX_MODEL_LEN,
        "max_num_seqs": MAX_CONCURRENT_INPUTS,
        "enable_auto_tool_choice": True,
        "tool_call_parser": "qwen3_xml",
        "reasoning_parser": "qwen3",
        "enable_thinking": False,
        "language_model_only": True,
        "force_include_usage": True,
        "cudagraph_capture_sizes": [1, 2, 4, 8],
        "gpu_memory_utilization": 0.85,
        "enable_sleep_mode": True,
    }


def model_alias(artifact):
    return "ama-artifact-" + artifact["artifact_sha256"]


def server_alias(config):
    return "ama-serving-" + digest(config)


def build_server_command(model_dir, template_path, port=8000, served_name="ama"):
    """Build flags from the same verified configuration advertised by the server."""
    artifact = load_model_artifact(model_dir)
    config = server_config(artifact, template_path)
    command = [
        "vllm",
        "serve",
        str(model_dir),
        "--served-model-name",
        model_alias(artifact),
        served_name,
        server_alias(config),
        "--max-model-len",
        str(config["max_model_len"]),
        "--max-num-seqs",
        str(config["max_num_seqs"]),
        "--tool-call-parser",
        config["tool_call_parser"],
        "--reasoning-parser",
        config["reasoning_parser"],
        "--default-chat-template-kwargs",
        json.dumps({"enable_thinking": config["enable_thinking"]}),
        "--compilation-config",
        json.dumps({"cudagraph_capture_sizes": config["cudagraph_capture_sizes"]}),
        "--gpu-memory-utilization",
        str(config["gpu_memory_utilization"]),
        "--chat-template",
        str(template_path),
        "--port",
        str(port),
    ]
    for key, flag in {
        "enable_auto_tool_choice": "--enable-auto-tool-choice",
        "language_model_only": "--language-model-only",
        "force_include_usage": "--enable-force-include-usage",
        "enable_sleep_mode": "--enable-sleep-mode",
    }.items():
        if config[key]:
            command.append(flag)
    return command
