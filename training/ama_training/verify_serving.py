"""Probe a candidate's real serving endpoint and write evidence; never deploy or promote.

python -m ama_training.verify_serving model_dir=<merged-dir> template=<jinja> \\
  runtime_settings=<json> out=<report.json>

Endpoint/auth use the existing AMA_INFERENCE_* environment variables. The runtime
settings file contains call_settings and optional reasoning_effort; copy the exact
settings from the production evaluation report. Credentials are never recorded.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sys
import urllib.parse
import urllib.request

from ama_training.provenance import digest, seal, write
from ama_training.serving_identity import (
    load_model_artifact,
    model_alias,
    server_alias,
    server_config,
)
from deploy.prime_modal import parse_inference_headers, prime_modal_endpoint

CANARY = "QUARTZ_RELEASE_GROUNDING_731"
TOOL = {
    "type": "function",
    "function": {
        "name": "search_personal_context",
        "description": "Read Jonathan's side-project notes.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
            "additionalProperties": False,
        },
    },
}
FIXTURE = [
    {
        "role": "system",
        "content": "Answer as Jonathan. For side-project details call search_personal_context once. Then report the verification label supplied by that tool verbatim. Do not include reasoning or XML in the final answer.",
    },
    {
        "role": "user",
        "content": "How did you build your LanternNote side project, and what is its verification label?",
    },
]


def validate_runtime(settings):
    if not isinstance(settings, dict) or set(settings) - {"call_settings", "reasoning_effort"}:
        raise ValueError("invalid runtime settings")
    calls = settings.get("call_settings")
    if not isinstance(calls, dict) or set(calls) != {
        "maxOutputTokens",
        "temperature",
        "seed",
        "maxRetries",
    }:
        raise ValueError("expected exact production inference call settings")
    budget = calls["maxOutputTokens"]
    if (
        type(budget) is not int
        or budget <= 0
        or any(isinstance(calls[key], bool) for key in ("temperature", "seed", "maxRetries"))
        or calls["temperature"] != 0
        or calls["seed"] != 1
        or calls["maxRetries"] != 0
    ):
        raise ValueError("invalid production inference settings")
    # This serving template is deliberately non-thinking.
    if isinstance(settings.get("reasoning_effort"), bool) or settings.get(
        "reasoning_effort"
    ) not in (None, "none", 0):
        raise ValueError("non-thinking serving template cannot verify a thinking checkpoint")
    return settings


def read_completion_stream(response):
    """Read OpenAI SSE, rejecting incomplete framing and unfinished tool arguments."""
    content, calls, models, reasons = "", {}, set(), []
    usage, done, data, byte_count = None, False, [], 0
    for raw_line in response:
        byte_count += len(raw_line)
        if byte_count > 2_000_000:
            raise ValueError("oversized verification stream")
        line = raw_line.decode("utf-8").rstrip("\r\n")
        if line.startswith("data:"):
            data.append(line[5:].lstrip(" "))
        elif not line and data:
            payload = "\n".join(data)
            data = []
            if payload == "[DONE]":
                done = True
                break
            event = json.loads(payload)
            if not isinstance(event, dict) or "error" in event:
                raise ValueError("invalid completion stream")
            if event.get("model"):
                models.add(event["model"])
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices", []):
                if reasons:
                    raise ValueError("completion choice arrived after its finish reason")
                if choice.get("index", 0) != 0:
                    raise ValueError("unexpected completion choice")
                delta = choice.get("delta", {})
                content += delta.get("content") or ""
                if delta.get("reasoning_content") or delta.get("reasoning"):
                    raise ValueError("unexpected reasoning")
                for call in delta.get("tool_calls", []):
                    index = call["index"]
                    if type(index) is not int or index < 0:
                        raise ValueError("invalid tool-call index")
                    target = calls.setdefault(
                        index,
                        {"id": "", "type": "function", "function": {"name": "", "arguments": ""}},
                    )
                    if call.get("id"):
                        if target["id"] and target["id"] != call["id"]:
                            raise ValueError("tool id changed")
                        target["id"] = call["id"]
                    function = call.get("function", {})
                    target["function"]["name"] += function.get("name", "")
                    target["function"]["arguments"] += function.get("arguments", "")
                if choice.get("finish_reason"):
                    reasons.append(choice["finish_reason"])
    if not done or data or len(reasons) != 1:
        raise ValueError("incomplete completion stream")
    if not isinstance(usage, dict) or any(
        type(usage.get(key)) is not int or usage[key] < 0
        for key in ("prompt_tokens", "completion_tokens")
    ):
        raise ValueError("complete nonnegative token usage required")
    return {
        "content": content,
        "tool_calls": [calls[index] for index in sorted(calls)],
        "models": sorted(models),
        "finish_reason": reasons[0],
        "usage": usage,
        "byte_count": byte_count,
    }


def verify_serving(
    *,
    model_dir,
    template,
    runtime_settings,
    base_url,
    headers,
    urlopen=urllib.request.urlopen,
    parity_checker=None,
    primer=None,
):
    artifact = load_model_artifact(model_dir)
    settings = validate_runtime(runtime_settings)
    parsed = urllib.parse.urlsplit(base_url)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("invalid inference base URL")
    base_url = base_url.rstrip("/")
    server = server_config(artifact, template)
    config = {"server": server, **settings}
    alias = model_alias(artifact)
    checks = {
        name: False
        for name in ["artifact_identity", "template_parity", "tool_call", "stream", "readiness"]
    }
    report = {
        "schema_version": 1,
        "kind": "ama_serving_verification",
        "candidate_id": artifact["candidate_id"],
        "checkpoint_path": artifact["checkpoint_path"],
        "model_artifact_sha256": artifact["artifact_sha256"],
        "serving_config_sha256": digest(config),
        "config": config,
        "endpoint": base_url,
        "model": alias,
        "fixture_sha256": digest({"messages": FIXTURE, "tool": TOOL, "canary": CANARY}),
        "checks": checks,
        "observations": {},
    }
    try:
        if parity_checker is None:
            from transformers import AutoTokenizer
            from ama_training.template_parity import check_template_parity

            tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
            parity = check_template_parity(Path(template), tokenizer)
        else:
            parity = parity_checker(Path(template), Path(model_dir))
        report["observations"]["template_parity"] = parity
        checks["template_parity"] = parity.get("passed") is True
        if not checks["template_parity"]:
            raise ValueError("template parity failed before network probes")
        prime = primer or prime_modal_endpoint
        attempts = prime(
            base_url=base_url, model=alias, headers=headers, timeout_seconds=285, urlopen=urlopen
        )
        checks["readiness"] = True
        report["observations"]["readiness_attempts"] = attempts
        request = urllib.request.Request(base_url + "/models", headers=headers)
        with urlopen(request, timeout=30) as response:
            models = {item["id"] for item in json.load(response)["data"]}
        checks["artifact_identity"] = {alias, server_alias(server)}.issubset(models)
        if not checks["artifact_identity"]:
            raise ValueError("endpoint identity mismatch")
        report["observations"]["model_alias"] = alias
        report["observations"]["server_alias"] = server_alias(server)
        calls = settings["call_settings"]

        def complete(messages):
            payload = {
                "model": alias,
                "messages": messages,
                "tools": [TOOL],
                "tool_choice": "auto",
                "stream": True,
                "stream_options": {"include_usage": True},
                "max_tokens": calls["maxOutputTokens"],
                "temperature": calls["temperature"],
                "seed": calls["seed"],
            }
            if settings.get("reasoning_effort") is not None:
                payload["reasoning_effort"] = settings["reasoning_effort"]
            req = urllib.request.Request(
                base_url + "/chat/completions",
                data=json.dumps(payload).encode(),
                headers={**headers, "Content-Type": "application/json"},
                method="POST",
            )
            with urlopen(req, timeout=285) as response:
                return read_completion_stream(response)

        first = complete(FIXTURE)
        if (
            first["finish_reason"] != "tool_calls"
            or len(first["tool_calls"]) != 1
            or first["models"] != [alias]
        ):
            raise ValueError("expected exactly one streamed tool call")
        call = first["tool_calls"][0]
        arguments = json.loads(call["function"]["arguments"])
        if (
            not call["id"]
            or call["function"]["name"] != TOOL["function"]["name"]
            or not isinstance(arguments, dict)
            or set(arguments) != {"query"}
            or not isinstance(arguments["query"], str)
            or not arguments["query"].strip()
        ):
            raise ValueError("invalid tool contract")
        second = complete(
            [
                *FIXTURE,
                {"role": "assistant", "content": first["content"], "tool_calls": [call]},
                {
                    "role": "tool",
                    "tool_call_id": call["id"],
                    "name": call["function"]["name"],
                    "content": json.dumps(
                        {
                            "available": True,
                            "content": "LanternNote's verification label is " + CANARY,
                        }
                    ),
                },
            ]
        )
        checks["tool_call"] = (
            second["finish_reason"] == "stop"
            and not second["tool_calls"]
            and CANARY in second["content"]
        )
        checks["stream"] = (
            second["models"] == [alias]
            and bool(second["content"].strip())
            and not any(
                marker in turn["content"].lower()
                for turn in [first, second]
                for marker in ["<think", "<tool_call"]
            )
            and all(isinstance(turn["usage"], dict) for turn in [first, second])
        )
        report["observations"]["turns"] = [
            {
                "finish_reason": turn["finish_reason"],
                "byte_count": turn["byte_count"],
                "content_sha256": digest(turn["content"]),
                "tool_call_count": len(turn["tool_calls"]),
            }
            for turn in [first, second]
        ]
    except Exception as error:
        # Provider messages and response bodies may contain private data.
        report["failure_type"] = type(error).__name__
    report["passed"] = "failure_type" not in report and all(checks.values())
    return seal(report)


def main(argv=None):
    args = dict(item.split("=", 1) for item in (argv if argv is not None else sys.argv[1:]))
    if set(args) != {"model_dir", "template", "runtime_settings", "out"}:
        raise ValueError("required arguments: model_dir, template, runtime_settings, out")
    out = Path(args["out"]).resolve()
    if out.is_relative_to(Path(args["model_dir"]).resolve()):
        raise ValueError("verification reports must be outside the immutable model directory")
    report = verify_serving(
        model_dir=args["model_dir"],
        template=args["template"],
        runtime_settings=json.loads(Path(args["runtime_settings"]).read_text()),
        base_url=os.environ.get("AMA_INFERENCE_BASE_URL", ""),
        headers=parse_inference_headers(
            os.environ.get("AMA_INFERENCE_HEADERS"), os.environ.get("AMA_INFERENCE_API_KEY")
        ),
    )
    write(out, report)
    print(json.dumps({"passed": report["passed"], "checks": report["checks"], "report": str(out)}))
    if not report["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
