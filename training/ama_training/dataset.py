"""Dataset builder for AMA trace exports.

Replaces the cookbook's FromConversationFileBuilder for two reasons:

1. Qwen-family renderers access tool calls attribute-style
   (``tool_call.function.name``), so tool-call training data must be
   constructed as ``ToolCall`` objects before rendering — plain JSONL dicts
   (or dicts round-tripped through HF/Arrow) crash or mis-render.
2. The system prompt and tool declarations are not in the export rows; they
   are rebuilt per row from prompt-manifest.json with the target renderer's
   own ``create_conversation_prefix_with_tools``, so tool declarations land
   exactly where that renderer's serving template puts them.
"""

import json
import random
from collections.abc import Callable, Sequence

import chz
import tinker
from tinker_cookbook.renderers import Message, ToolCall, TrainOnWhat
from tinker_cookbook.supervised.common import datum_from_model_input_weights
from tinker_cookbook.supervised.types import ChatDatasetBuilder, SupervisedDataset

from ama_training.manifest import load_manifest


def convert_message(raw: dict) -> Message:
    """Convert one exported OpenAI-format message into a cookbook Message."""
    role = raw["role"]
    if role == "user":
        return {"role": "user", "content": raw["content"]}
    if role == "assistant":
        message: Message = {"role": "assistant", "content": raw["content"] or ""}
        if raw.get("tool_calls"):
            message["tool_calls"] = [ToolCall.model_validate(tc) for tc in raw["tool_calls"]]
        return message
    if role == "tool":
        return {
            "role": "tool",
            "content": raw["content"],
            "tool_call_id": raw["tool_call_id"],
            "name": raw["name"],
        }
    # The export never contains system messages — the system prompt is
    # reconstructed from the manifest so it renders through the renderer's
    # own prefix construction.
    raise ValueError(f"unsupported role in trace export: {role!r}")


class InMemorySupervisedDataset(SupervisedDataset):
    """Batches pre-built conversations, tokenizing lazily per batch."""

    def __init__(
        self,
        conversations: Sequence[list[Message]],
        batch_size: int,
        to_datum: Callable[[list[Message]], tinker.Datum],
    ):
        self.conversations = list(conversations)
        self._order = list(self.conversations)
        self._batch_size = batch_size
        self._to_datum = to_datum

    def get_batch(self, index: int) -> list[tinker.Datum]:
        start = index * self._batch_size
        return [self._to_datum(c) for c in self._order[start : start + self._batch_size]]

    def set_epoch(self, seed: int = 0):
        self._order = list(self.conversations)
        random.Random(seed).shuffle(self._order)

    def __len__(self) -> int:
        return (len(self.conversations) + self._batch_size - 1) // self._batch_size


@chz.chz
class AmaTraceDatasetBuilder(ChatDatasetBuilder):
    """Builds supervised datasets from an export JSONL + prompt manifest.

    Attributes:
        file_path: JSONL from export-traces.mjs (per-turn or collapsed —
            the construction is decided at export time; this builder treats
            every line as one example).
        manifest_path: prompt-manifest.json from the same export.
        test_size: examples held out for NLL evaluation.
        shuffle_seed: seed for the pre-split shuffle.
        effort: tml_v0 only — thinking-effort injected into the rendered
            example. Must match the effort used at serving time. None uses
            the renderer default (0.9).
    """

    file_path: str
    manifest_path: str
    test_size: int = 0
    shuffle_seed: int = 0
    effort: float | None = None

    def __call__(self) -> tuple[SupervisedDataset, SupervisedDataset | None]:
        versions = load_manifest(self.manifest_path)
        renderer = self.renderer
        prefixes: dict[str, list[Message]] = {}
        conversations: list[list[Message]] = []
        with open(self.file_path) as f:
            for line in f:
                row = json.loads(line)
                version = row["system_prompt_version"]
                if version not in prefixes:
                    if version not in versions:
                        raise ValueError(
                            f"trace row references system_prompt_version {version} "
                            f"missing from {self.manifest_path}"
                        )
                    prompt = versions[version]
                    prefixes[version] = renderer.create_conversation_prefix_with_tools(
                        prompt.tools, prompt.system_prompt
                    )
                conversations.append(
                    [*prefixes[version], *(convert_message(m) for m in row["messages"])]
                )

        random.Random(self.shuffle_seed).shuffle(conversations)
        if 0 < self.test_size < len(conversations):
            test, train = conversations[: self.test_size], conversations[self.test_size :]
        else:
            test, train = [], conversations

        train_on_what = (
            TrainOnWhat(self.common_config.train_on_what)
            if self.common_config.train_on_what
            else TrainOnWhat.ALL_ASSISTANT_MESSAGES
        )

        def to_datum(conversation: list[Message]) -> tinker.Datum:
            kwargs: dict = {"train_on_what": train_on_what}
            if self.effort is not None:
                kwargs["effort"] = self.effort
            model_input, weights = renderer.build_supervised_example(conversation, **kwargs)
            return datum_from_model_input_weights(
                model_input, weights, self.common_config.max_length, reduction="mean"
            )

        train_dataset = InMemorySupervisedDataset(
            train, self.common_config.batch_size, to_datum
        )
        test_dataset = (
            InMemorySupervisedDataset(test, len(test), to_datum) if test else None
        )
        return train_dataset, test_dataset
