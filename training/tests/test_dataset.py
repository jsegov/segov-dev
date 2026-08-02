"""Dataset-builder tests. These run real renderers/tokenizers (no Tinker API
key needed): the Qwen tests download the HF tokenizer on first run; the tml_v0
tests exercise the tml_renderers package installed via the inkling extra.
"""

import json

import pytest
from tinker_cookbook.renderers import ToolCall, TrainOnWhat
from tinker_cookbook.supervised.types import ChatDatasetBuilderCommonConfig

from ama_training.dataset import (
    AmaTraceDatasetBuilder,
    InMemorySupervisedDataset,
    convert_message,
)

VERSION = "testversion"

MANIFEST = {
    VERSION: {
        "version": VERSION,
        "instructions": "You are Jonathan's terminal assistant. Answer as Jonathan.",
        "tool_declarations": [
            {
                "name": "search_work_context",
                "description": "Search work docs.",
                "inputSchema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "additionalProperties": False,
                },
            }
        ],
        "call_settings": {},
    }
}

TOOL_ROW = {
    "conversation_id": "c1",
    "turn": 1,
    "system_prompt_version": VERSION,
    "model": "test",
    "messages": [
        {"role": "user", "content": "USERQUESTIONALPHA what did you build?"},
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {
                        "name": "search_work_context",
                        "arguments": '{"query": "QUERYARGBRAVO"}',
                    },
                }
            ],
        },
        {
            "role": "tool",
            "tool_call_id": "call_1",
            "name": "search_work_context",
            "content": '{"result": "TOOLRESULTCHARLIE"}',
        },
        {"role": "assistant", "content": "FINALANSWERDELTA: I built a pipeline."},
    ],
}

MULTITURN_ROW = {
    "conversation_id": "c2",
    "turns": 2,
    "system_prompt_version": VERSION,
    "model": "test",
    "messages": [
        {"role": "user", "content": "USERQUESTIONALPHA hello?"},
        {"role": "assistant", "content": "FIRSTREPLYECHO hi."},
        {"role": "user", "content": "USERFOLLOWUPFOX more?"},
        {"role": "assistant", "content": "SECONDREPLYGOLF sure."},
    ],
}


@pytest.fixture(scope="module")
def export_dir(tmp_path_factory):
    d = tmp_path_factory.mktemp("export")
    (d / "prompt-manifest.json").write_text(json.dumps(MANIFEST))
    (d / "traces.jsonl").write_text(
        json.dumps(TOOL_ROW) + "\n" + json.dumps(MULTITURN_ROW) + "\n"
    )
    return d


def make_builder(export_dir, model_name, renderer_name, train_on_what, **kwargs):
    return AmaTraceDatasetBuilder(
        file_path=str(export_dir / "traces.jsonl"),
        manifest_path=str(export_dir / "prompt-manifest.json"),
        common_config=ChatDatasetBuilderCommonConfig(
            model_name_for_tokenizer=model_name,
            renderer_name=renderer_name,
            max_length=None,
            batch_size=2,
            train_on_what=train_on_what,
        ),
        **kwargs,
    )


def decode_regions(builder, conversation, train_on_what):
    """Return (decoded trained region, decoded full example)."""
    renderer = builder.renderer
    model_input, weights = renderer.build_supervised_example(
        conversation, train_on_what=train_on_what
    )
    tokens = model_input.to_ints()
    flags = weights.tolist()
    assert len(tokens) == len(flags)
    trained = [t for t, w in zip(tokens, flags) if w > 0]
    assert trained, "no trained tokens"
    return builder.tokenizer.decode(trained), builder.tokenizer.decode(tokens)


class TestConvertMessage:
    def test_assistant_tool_calls_become_objects(self):
        message = convert_message(TOOL_ROW["messages"][1])
        assert message["content"] == ""
        (tool_call,) = message["tool_calls"]
        assert isinstance(tool_call, ToolCall)
        assert tool_call.function.name == "search_work_context"
        assert json.loads(tool_call.function.arguments) == {"query": "QUERYARGBRAVO"}

    def test_tool_message_keeps_id_and_name(self):
        message = convert_message(TOOL_ROW["messages"][2])
        assert message == {
            "role": "tool",
            "content": '{"result": "TOOLRESULTCHARLIE"}',
            "tool_call_id": "call_1",
            "name": "search_work_context",
        }

    def test_system_role_rejected(self):
        with pytest.raises(ValueError, match="unsupported role"):
            convert_message({"role": "system", "content": "x"})


class TestQwenConstruction:
    MODEL = "Qwen/Qwen3.5-4B"
    RENDERER = "qwen3_5_disable_thinking"

    @pytest.fixture(scope="class")
    def builder(self, export_dir):
        return make_builder(
            export_dir, self.MODEL, self.RENDERER, TrainOnWhat.LAST_ASSISTANT_TURN
        )

    @pytest.fixture(scope="class")
    def conversations(self, builder):
        train, test = builder()
        assert test is None
        assert len(train.conversations) == 2
        return {
            ("tool" if any("tool_calls" in m for m in c) else "plain"): c
            for c in train.conversations
        }

    def test_prefix_carries_system_prompt_and_tools(self, conversations):
        prefix_message = conversations["tool"][0]
        assert prefix_message["role"] == "system"
        assert "terminal assistant" in prefix_message["content"]
        assert "search_work_context" in prefix_message["content"]

    def test_last_turn_masking(self, builder, conversations):
        trained, full = decode_regions(
            builder, conversations["tool"], TrainOnWhat.LAST_ASSISTANT_TURN
        )
        # The whole tool loop is one assistant turn: call + final answer train.
        assert "FINALANSWERDELTA" in trained
        assert "QUERYARGBRAVO" in trained
        # Prompt, user text, and tool observations never take loss.
        assert "USERQUESTIONALPHA" not in trained
        assert "TOOLRESULTCHARLIE" not in trained
        assert "terminal assistant" not in trained
        # ...but they are all present in the rendered example.
        assert "USERQUESTIONALPHA" in full
        assert "TOOLRESULTCHARLIE" in full

    def test_multiturn_last_turn_only(self, builder, conversations):
        trained, _ = decode_regions(
            builder, conversations["plain"], TrainOnWhat.LAST_ASSISTANT_TURN
        )
        assert "SECONDREPLYGOLF" in trained
        assert "FIRSTREPLYECHO" not in trained

    def test_render_parity_with_generation_prompt(self, builder, conversations):
        # The supervised example must start with exactly the tokens
        # build_generation_prompt produces for the same prefix, so the model
        # trains on the distribution it sees at inference.
        conversation = conversations["plain"]
        renderer = builder.renderer
        model_input, _ = renderer.build_supervised_example(
            conversation, train_on_what=TrainOnWhat.LAST_ASSISTANT_TURN
        )
        generation = renderer.build_generation_prompt(conversation[:-1])
        supervised_tokens = model_input.to_ints()
        generation_tokens = generation.to_ints()
        assert supervised_tokens[: len(generation_tokens)] == generation_tokens


class TestTmlConstruction:
    MODEL = "thinkingmachines/Inkling-Small"
    RENDERER = "tml_v0"

    @pytest.fixture(scope="class")
    def builder(self, export_dir):
        return make_builder(
            export_dir, self.MODEL, self.RENDERER, TrainOnWhat.ALL_ASSISTANT_MESSAGES
        )

    @pytest.fixture(scope="class")
    def conversations(self, builder):
        train, _ = builder()
        return {
            ("tool" if any("tool_calls" in m for m in c) else "plain"): c
            for c in train.conversations
        }

    def test_prefix_uses_tool_declare_role(self, conversations):
        roles = [m["role"] for m in conversations["tool"][:2]]
        assert "tool_declare" in roles

    def test_all_assistant_messages_train(self, builder, conversations):
        trained, full = decode_regions(
            builder, conversations["plain"], TrainOnWhat.ALL_ASSISTANT_MESSAGES
        )
        # Collapsed construction: every assistant message takes loss once.
        assert "FIRSTREPLYECHO" in trained
        assert "SECONDREPLYGOLF" in trained
        assert "USERQUESTIONALPHA" not in trained
        assert "USERFOLLOWUPFOX" not in trained
        assert "USERQUESTIONALPHA" in full

    def test_tool_loop_masks_observations(self, builder, conversations):
        trained, _ = decode_regions(
            builder, conversations["tool"], TrainOnWhat.ALL_ASSISTANT_MESSAGES
        )
        assert "FINALANSWERDELTA" in trained
        assert "QUERYARGBRAVO" in trained
        assert "TOOLRESULTCHARLIE" not in trained


class TestDatasetMechanics:
    def test_partial_final_batch_is_included(self):
        conversations = [
            [{"role": "user", "content": f"prompt-{index}"}] for index in range(5)
        ]
        dataset = InMemorySupervisedDataset(
            conversations=conversations,
            batch_size=2,
            to_datum=lambda conversation: conversation,
        )

        assert len(dataset) == 3
        assert dataset.get_batch(2) == conversations[4:]

    def test_set_epoch_deterministic(self, export_dir):
        builder = make_builder(
            export_dir,
            "Qwen/Qwen3.5-4B",
            "qwen3_5_disable_thinking",
            TrainOnWhat.LAST_ASSISTANT_TURN,
        )
        a, _ = builder()
        b, _ = builder()
        a.set_epoch(seed=3)
        b.set_epoch(seed=3)
        assert a._order == b._order

    def test_test_split_holds_out(self, export_dir):
        builder = make_builder(
            export_dir,
            "Qwen/Qwen3.5-4B",
            "qwen3_5_disable_thinking",
            TrainOnWhat.LAST_ASSISTANT_TURN,
            test_size=1,
        )
        train, test = builder()
        assert len(train.conversations) == 1
        assert len(test.conversations) == 1
