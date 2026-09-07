from copy import deepcopy

import pytest

from ama_training.dataset import validate_tool_pairing


def conversation():
    return [
        {"role": "user", "content": "Synthetic question."},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {"id": "a", "type": "function", "function": {"name": "public", "arguments": "{}"}},
                {
                    "id": "b",
                    "type": "function",
                    "function": {"name": "personal", "arguments": '{"query":"synthetic"}'},
                },
            ],
        },
        {"role": "tool", "tool_call_id": "a", "name": "public", "content": "Public fixture."},
        {
            "role": "tool",
            "tool_call_id": "b",
            "name": "personal",
            "content": "Private synthetic fixture.",
        },
        {"role": "assistant", "content": "Synthetic answer."},
    ]


TOOLS = [{"name": "public"}, {"name": "personal"}]


def test_parallel_calls_pair_with_exact_historical_names_and_ids():
    validate_tool_pairing(conversation(), TOOLS)


@pytest.mark.parametrize(
    "mutation",
    [
        "missing",
        "duplicate",
        "wrong_id",
        "wrong_name",
        "reordered",
        "unknown_tool",
        "duplicate_call_id",
        "invalid_json",
        "array_arguments",
        "unfinished",
        "system",
    ],
)
def test_malformed_tool_history_fails_before_rendering(mutation):
    messages = deepcopy(conversation())
    if mutation == "missing":
        del messages[3]
    elif mutation == "duplicate":
        messages.insert(3, deepcopy(messages[2]))
    elif mutation == "wrong_id":
        messages[2]["tool_call_id"] = "not-a"
    elif mutation == "wrong_name":
        messages[2]["name"] = "personal"
    elif mutation == "reordered":
        messages[2], messages[3] = messages[3], messages[2]
    elif mutation == "unknown_tool":
        messages[1]["tool_calls"][0]["function"]["name"] = "not-declared"
    elif mutation == "duplicate_call_id":
        messages[1]["tool_calls"][1]["id"] = "a"
    elif mutation in {"invalid_json", "array_arguments"}:
        messages[1]["tool_calls"][0]["function"]["arguments"] = (
            "{" if mutation == "invalid_json" else "[]"
        )
    elif mutation == "unfinished":
        messages.pop()
    elif mutation == "system":
        messages.insert(0, {"role": "system", "content": "Substitute prompt."})
    with pytest.raises(ValueError):
        validate_tool_pairing(messages, TOOLS)
