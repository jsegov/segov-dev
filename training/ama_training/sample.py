"""Sample from a fine-tuned checkpoint with train-identical rendering.

Renders through the same renderer + manifest prefix the training data used
(zero template skew), so this measures the model, not the serving endpoint.

    TINKER_API_KEY=... uv run python -m ama_training.sample \
        preset=inkling-small checkpoint=tinker://.../sampler_weights/final \
        [prompt="one question"] [temperature=0.0]

Without prompt=, runs the built-in smoke set (tool routing, out-of-scope
refusal, no-tool small talk, personal-project routing).
"""

import asyncio
import sys

import tinker
from tinker_cookbook import renderers
from tinker_cookbook.tokenizer_utils import get_tokenizer

from ama_training.manifest import load_manifest
from ama_training.train import EXPORT_DIR, PRESETS

SMOKE_PROMPTS = [
    "what did you work on at Amazon?",
    "What's the capital of France?",
    "hey!",
    "tell me about the shipspec plugin you built",
]

# The teacher's canned refusal — the fine-tune should reproduce it byte-exact.
OUT_OF_SCOPE_MESSAGE = (
    "Error: Query outside permitted scope. "
    "This terminal only responds to questions about me, Jonathan Segovia."
)


async def run(preset_name: str, checkpoint: str, prompts: list[str], temperature: float) -> None:
    preset = PRESETS[preset_name]
    tokenizer = get_tokenizer(preset["model_name"])
    renderer = renderers.get_renderer(preset["renderer_name"], tokenizer)

    manifest = load_manifest(EXPORT_DIR / "prompt-manifest.json")
    (prompt_version,) = manifest.values()
    prefix = renderer.create_conversation_prefix_with_tools(
        prompt_version.tools, prompt_version.system_prompt
    )

    service_client = tinker.ServiceClient()
    sampling_client = service_client.create_sampling_client(model_path=checkpoint)

    for question in prompts:
        model_input = renderer.build_generation_prompt([*prefix, {"role": "user", "content": question}])
        response = await sampling_client.sample_async(
            model_input,
            num_samples=1,
            sampling_params=tinker.SamplingParams(
                temperature=temperature,
                max_tokens=1024,
                stop=renderer.get_stop_sequences(),
            ),
        )
        message, termination = renderer.parse_response(response.sequences[0].tokens)

        print(f"\n=== user: {question}")
        print(f"[termination={termination.value}]")
        for tool_call in message.get("tool_calls", []):
            print(f"[tool_call] {tool_call.function.name} {tool_call.function.arguments}")
        content = message.get("content")
        if content:
            text = content if isinstance(content, str) else "".join(
                p.get("text", "") for p in content if p.get("type") == "text"
            )
            print(text)
            if text.strip() == OUT_OF_SCOPE_MESSAGE:
                print("[refusal: BYTE-EXACT match]")


def main(argv: list[str]) -> None:
    preset_name = "inkling-small"
    checkpoint = None
    prompts: list[str] = []
    temperature = 0.0
    for arg in argv:
        key, _, value = arg.partition("=")
        if key == "preset":
            preset_name = value
        elif key == "checkpoint":
            checkpoint = value
        elif key == "prompt":
            prompts.append(value)
        elif key == "temperature":
            temperature = float(value)
        else:
            raise SystemExit(f"unknown arg {arg!r}")
    if preset_name not in PRESETS:
        raise SystemExit(f"unknown preset {preset_name!r}; choose from {sorted(PRESETS)}")
    if not checkpoint:
        raise SystemExit("checkpoint=tinker://... is required")
    asyncio.run(run(preset_name, checkpoint, prompts or SMOKE_PROMPTS, temperature))


if __name__ == "__main__":
    main(sys.argv[1:])
