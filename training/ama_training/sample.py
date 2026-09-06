"""Candidate smoke tests with explicit captured-prompt selection.

Use prompt_version=<version> to inspect one captured version, or
prompt_version=all to cover every candidate prompt version for promotion.
Omission is accepted only when the manifest contains one version. Selection
errors are checked before creating a Tinker client. Reports contain hashes and
tool metadata rather than raw generated text.
"""
import asyncio
import json
from pathlib import Path
import sys

import tinker
from ama_training.manifest import load_manifest
from ama_training.registry import candidate
from ama_training.train import resolve_config
from ama_training.preflight import run_preflight
from ama_training.provenance import digest, seal, write

FIXTURES = Path(__file__).with_name("smoke_fixtures.json")


def load_fixtures(path=FIXTURES):
    value = json.loads(Path(path).read_text())
    ids = [fixture["id"] for fixture in value["fixtures"]]
    if not ids or len(ids) != len(set(ids)):
        raise ValueError("nonempty unique smoke fixtures required")
    return value


def fixture_response(fixture, name):
    if name not in fixture["tool_results"]:
        raise ValueError(f"unexpected tool {name} in fixture {fixture['id']}")
    return json.dumps(fixture["tool_results"][name], separators=(",", ":"))


def assess(fixture, called, text, finished):
    expected = fixture["expected_tool"]
    return bool(
        finished
        and text.strip()
        and (set(called) == {expected} if expected else not called)
        and (not fixture.get("required_text") or fixture["required_text"].lower() in text.lower())
        and (not fixture.get("exact_text") or text.strip() == fixture["exact_text"])
    )


def select_prompt_versions(manifest, candidate_versions, prompt_version=None):
    """Resolve one version or explicitly all candidate versions, without inference."""
    allowed = set(candidate_versions)
    if not manifest or not allowed or not allowed.issubset(manifest):
        raise ValueError("candidate prompt versions are missing from the captured manifest")
    if prompt_version is None:
        if len(manifest) != 1:
            raise ValueError(
                "manifest contains multiple prompt versions; set "
                "prompt_version=<version> or prompt_version=all explicitly"
            )
        prompt_version = next(iter(manifest))
    if not isinstance(prompt_version, str) or not prompt_version.strip():
        raise ValueError("prompt_version must name a captured version or all")
    requested = prompt_version.strip()
    if requested == "all":
        return {version: manifest[version] for version in sorted(allowed)}
    if requested not in manifest:
        raise ValueError("unknown prompt_version in the captured manifest")
    if requested not in allowed:
        raise ValueError("prompt_version is not part of the candidate's training preflight")
    return {requested: manifest[requested]}


async def run(candidate_id, config, output, *, prompt_version=None):
    selected = candidate(candidate_id)
    preflight = run_preflight(config)
    if (
        selected["preflight_sha256"] != preflight["artifact_sha256"]
        or selected["training_config_sha256"] != preflight["training_config_sha256"]
        or selected["dataset_sha256"] != preflight["dataset_sha256"]
    ):
        raise ValueError("smoke configuration differs from training")
    builder, fixtures = config.dataset_builder, load_fixtures()
    versions = select_prompt_versions(
        load_manifest(builder.manifest_path), preflight["prompt_versions"], prompt_version
    )
    service = tinker.ServiceClient()
    client = service.create_sampling_client(model_path=selected["checkpoint_path"])
    results = []
    for version, prompt in sorted(versions.items()):
        prefix = builder.renderer.create_conversation_prefix_with_tools(
            prompt.tools, prompt.system_prompt
        )
        for fixture in fixtures["fixtures"]:
            conversation = [*prefix, {"role": "user", "content": fixture["question"]}]
            called, text, finished, error = [], "", False, None
            try:
                for _ in range(4):
                    kwargs = {"effort": builder.effort} if builder.effort is not None else {}
                    model_input = builder.renderer.build_generation_prompt(conversation, **kwargs)
                    response = await client.sample_async(
                        model_input,
                        num_samples=1,
                        sampling_params=tinker.SamplingParams(
                            temperature=0,
                            max_tokens=2048,
                            stop=builder.renderer.get_stop_sequences(),
                        ),
                    )
                    message, termination = builder.renderer.parse_response(
                        response.sequences[0].tokens
                    )
                    tools = message.get("tool_calls", [])
                    content = message.get("content") or ""
                    text += (
                        content
                        if isinstance(content, str)
                        else "".join(p.get("text", "") for p in content if p.get("type") == "text")
                    )
                    conversation.append(message)
                    if not tools:
                        finished = termination.is_clean
                        break
                    for call in tools:
                        called.append(call.function.name)
                        json.loads(call.function.arguments)
                        conversation.append(
                            {
                                "role": "tool",
                                "name": call.function.name,
                                "tool_call_id": call.id or "call_0",
                                "content": fixture_response(fixture, call.function.name),
                            }
                        )
            except (ValueError, KeyError) as caught:
                error = str(caught)
            results.append(
                {
                    "prompt_version": version,
                    "fixture_id": fixture["id"],
                    "passed": assess(fixture, called, text, finished),
                    "called_tools": called,
                    "finished": finished,
                    "response_sha256": digest(text),
                    "error": error,
                }
            )
    report = seal(
        {
            "schema_version": 1,
            "kind": "ama_smoke",
            "candidate_id": candidate_id,
            "checkpoint_path": selected["checkpoint_path"],
            "dataset_sha256": selected["dataset_sha256"],
            "training_config_sha256": preflight["training_config_sha256"],
            "prompt_versions": sorted(versions),
            "prompt_version_selection": prompt_version or next(iter(versions)),
            "fixture_ids": [f["id"] for f in fixtures["fixtures"]],
            "fixtures_sha256": digest(fixtures),
            "results": results,
        }
    )
    write(output, report)
    if not all(r["passed"] for r in results):
        raise ValueError("smoke fixture failed; inspect the structured report")
    return report


def main(argv):
    own, rest = {}, []
    for arg in argv:
        key, _, value = arg.partition("=")
        if key in {"candidate", "output", "prompt_version"}:
            if key in own:
                raise ValueError(f"duplicate {key}= option")
            own[key] = value
        else:
            rest.append(arg)
    if not all(own.get(key, "").strip() for key in ("candidate", "output")):
        raise ValueError("candidate= and output= required, with actual training overrides")
    _, config = resolve_config(rest)
    asyncio.run(
        run(own["candidate"], config, own["output"], prompt_version=own.get("prompt_version"))
    )


if __name__ == "__main__":
    main(sys.argv[1:])
