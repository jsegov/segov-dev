"""Offline, exact-token parity checks for the Qwen3.5 serving template.

The caller supplies a tokenizer so this module never downloads files or calls a
model. Fixtures are synthetic and cover the prompt shapes used by AMA. Decoded
text equality alone is insufficient: chunked training tokenization can encode
the same whitespace with different token IDs from one-shot serving tokenization.
"""

import copy
import hashlib
import json
from pathlib import Path

from tinker_cookbook.renderers import ToolCall, get_renderer


def _fixtures() -> list[dict]:
    system = "You are a synthetic portfolio assistant. Answer from provided context."
    tools = [
        {
            "name": "search_context",
            "description": "Search synthetic résumé and project context.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "filters": {"type": "object"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        }
    ]
    user = {"role": "user", "content": "What synthetic projects did you build?"}
    call = {
        "id": "synthetic-call-1",
        "type": "function",
        "function": {"name": "search_context", "arguments": {"query": "projects"}},
    }
    assistant = {"role": "assistant", "content": "", "tool_calls": [call]}
    observation = {
        "role": "tool",
        "tool_call_id": call["id"],
        "name": "search_context",
        "content": '{"results": ["A synthetic event pipeline."]}',
    }
    nested_call = copy.deepcopy(call)
    nested_call["id"] = "synthetic-call-2"
    nested_call["function"]["arguments"] = {
        "query": "café tools",
        "filters": {"tags": ["demo", "résumé"], "limit": 2},
    }
    second_observation = {
        **observation,
        "tool_call_id": nested_call["id"],
        "content": '{"results": ["A synthetic café tool."]}',
    }
    return [
        {"id": "single_user", "system": system, "tools": [], "messages": [user]},
        {"id": "tool_schema", "system": system, "tools": tools, "messages": [user]},
        {
            "id": "tool_response",
            "system": system,
            "tools": tools,
            "messages": [user, assistant, observation],
        },
        {
            "id": "tool_response_with_text",
            "system": system,
            "tools": tools,
            "messages": [user, {**assistant, "content": "I will check the context."}, observation],
        },
        {
            "id": "parallel_tools_nested_arguments",
            "system": system,
            "tools": tools,
            "messages": [
                user,
                {**assistant, "tool_calls": [call, nested_call]},
                observation,
                second_observation,
            ],
        },
        {
            "id": "multiturn_tool_history",
            "system": system,
            "tools": tools,
            "messages": [
                user,
                assistant,
                observation,
                {"role": "assistant", "content": "I built a synthetic event pipeline."},
                {"role": "user", "content": "Which part handled the events?"},
            ],
        },
    ]


def _training_message(message: dict) -> dict:
    converted = copy.deepcopy(message)
    if converted.get("tool_calls"):
        for call in converted["tool_calls"]:
            call["function"]["arguments"] = json.dumps(call["function"]["arguments"])
        converted["tool_calls"] = [
            ToolCall.model_validate(call) for call in converted["tool_calls"]
        ]
    return converted


def _first_token_mismatch(training: list[int], serving: list[int]) -> dict | None:
    for index in range(max(len(training), len(serving))):
        training_token = training[index] if index < len(training) else None
        serving_token = serving[index] if index < len(serving) else None
        if training_token != serving_token:
            return {
                "index": index,
                "training_token": training_token,
                "serving_token": serving_token,
            }
    return None


def check_template_parity(template_path: Path, tokenizer) -> dict:
    """Compare serving prompts with the installed training renderer, without I/O to services.

    A case passes only when both UTF-8 bytes and exact token IDs match. Template
    rendering errors propagate so callers cannot accidentally release an invalid
    template. The hashes bind the report to the exact template and fixture set.
    """
    template_bytes = template_path.read_bytes()
    template = template_bytes.decode("utf-8")
    fixtures = _fixtures()
    renderer = get_renderer("qwen3_5_disable_thinking", tokenizer)
    cases = []
    for fixture in fixtures:
        prefix = renderer.create_conversation_prefix_with_tools(fixture["tools"], fixture["system"])
        training = renderer.build_generation_prompt(
            [*prefix, *(_training_message(message) for message in fixture["messages"])]
        ).to_ints()
        serving_text = tokenizer.apply_chat_template(
            [{"role": "system", "content": fixture["system"]}, *fixture["messages"]],
            tools=[{"type": "function", "function": tool} for tool in fixture["tools"]],
            chat_template=template,
            tokenize=False,
            add_generation_prompt=True,
            enable_thinking=False,
        )
        serving = tokenizer.encode(serving_text, add_special_tokens=False)
        training_text = tokenizer.decode(
            training, skip_special_tokens=False, clean_up_tokenization_spaces=False
        )
        case = {
            "id": fixture["id"],
            "byte_equal": training_text.encode("utf-8") == serving_text.encode("utf-8"),
            "token_equal": training == serving,
        }
        mismatch = _first_token_mismatch(training, serving)
        if mismatch is not None:
            case["first_token_mismatch"] = mismatch
        cases.append(case)
    return {
        "passed": all(case["byte_equal"] and case["token_equal"] for case in cases),
        "cases": cases,
        "fixture_sha256": hashlib.sha256(
            json.dumps(fixtures, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest(),
        "template_sha256": hashlib.sha256(template_bytes).hexdigest(),
    }
