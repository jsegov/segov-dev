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
from pathlib import Path

from ama_training.provenance import jsonl, verify_dataset
from ama_training.split import verify_split
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


def validate_tool_pairing(messages, declared_tools):
    """Validate complete historical turns before a renderer can discard tool IDs."""
    names = [tool["name"] for tool in declared_tools]
    if any(not name for name in names) or len(names) != len(set(names)):
        raise ValueError("historical tool declarations need unique nonempty names")
    if not isinstance(messages, list) or not messages:
        raise ValueError("nonempty conversation messages required")
    pending, seen = [], set()
    for message in messages:
        if not isinstance(message, dict):
            raise ValueError("invalid conversation message")
        role = message.get("role")
        content = message.get("content")
        if role == "tool":
            if not pending or message.get("tool_call_id") != pending[0][0]:
                raise ValueError("tool results must pair once in declared call order")
            _, name = pending.pop(0)
            if message.get("name") != name or not isinstance(content, str):
                raise ValueError("tool result name/content differs from its call")
            continue
        if pending:
            raise ValueError("missing tool results before the next conversation message")
        if role not in {"user", "assistant"}:
            raise ValueError("system context must come from the historical prompt manifest")
        calls = message.get("tool_calls", [])
        if role == "user" and calls:
            raise ValueError("only assistant messages can call tools")
        if not isinstance(calls, list) or not (
            isinstance(content, str) or (role == "assistant" and content is None and calls)
        ):
            raise ValueError("invalid conversation content or tool calls")
        for raw_call in calls:
            call = ToolCall.model_validate(raw_call)
            if call.type != "function" or not call.id or call.id in seen:
                raise ValueError("tool calls need unique nonempty function IDs")
            if call.function.name not in names:
                raise ValueError("tool call is absent from its historical prompt")
            if not isinstance(json.loads(call.function.arguments), dict):
                raise ValueError("tool arguments must be a JSON object")
            seen.add(call.id)
            pending.append((call.id, call.function.name))
    if pending:
        raise ValueError("conversation ends with missing tool results")
    last = messages[-1]
    if (
        last.get("role") != "assistant"
        or not isinstance(last.get("content"), str)
        or not last["content"].strip()
    ):
        raise ValueError("conversation must end with a completed assistant answer")


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
    dataset_manifest_path: str | None = None
    split_manifest_path: str | None = None
    # Only synthetic unit fixtures bypass provenance. The training/preflight entrypoints reject it.
    allow_unverified_fixture: bool = False
    test_size: int = 0
    shuffle_seed: int = 0
    effort: float | None = None

    def records(self):
        rows = jsonl(self.file_path)
        if not rows:
            raise ValueError("empty training construction")
        if self.allow_unverified_fixture:
            return [
                (row, "selection" if index < self.test_size else "train")
                for index, row in enumerate(rows)
            ]
        if not self.dataset_manifest_path or not self.split_manifest_path or self.test_size:
            raise ValueError(
                "verified dataset and persisted group split required; example test_size is forbidden"
            )
        manifest = verify_dataset(self.dataset_manifest_path)
        root = Path(self.dataset_manifest_path).parent.resolve()
        if (
            Path(self.file_path).resolve().parent != root
            or Path(self.file_path).name
            not in {"ama-traces-qwen.jsonl", "ama-traces-inkling.jsonl"}
            or Path(self.manifest_path).resolve() != root / "prompt-manifest.json"
        ):
            raise ValueError("dataset paths must belong to the verified manifest")
        split = verify_split(self.split_manifest_path, manifest["artifact_sha256"], rows)
        return [(row, split["assignments"][row["conversation_id"]]) for row in rows]

    def conversations_with_metadata(self):
        versions = load_manifest(self.manifest_path)
        prefixes = {}
        result = []
        for row, partition in self.records():
            version = row["system_prompt_version"]
            if version not in versions:
                raise ValueError(f"unknown prompt version {version}")
            prompt = versions[version]
            if prompt.tool_availability_policy_present:
                raise ValueError(
                    f"unsupported tool availability policy for prompt {version}: "
                    "step-specific training support is required"
                )
            validate_tool_pairing(row["messages"], prompt.tools)
            if version not in prefixes:
                prefixes[version] = self.renderer.create_conversation_prefix_with_tools(
                    prompt.tools, prompt.system_prompt
                )
            result.append(
                (
                    row,
                    partition,
                    [*prefixes[version], *(convert_message(m) for m in row["messages"])],
                )
            )
        return result

    def render(self, conversation):
        kwargs = {
            "train_on_what": TrainOnWhat(
                self.common_config.train_on_what or TrainOnWhat.ALL_ASSISTANT_MESSAGES
            )
        }
        if self.effort is not None:
            kwargs["effort"] = self.effort
        return self.renderer.build_supervised_example(conversation, **kwargs)

    def to_datum(self, conversation):
        model_input, weights = self.render(conversation)
        return datum_from_model_input_weights(
            model_input, weights, self.common_config.max_length, reduction="mean"
        )

    def __call__(self) -> tuple[SupervisedDataset, SupervisedDataset | None]:
        records = self.conversations_with_metadata()
        train = [conversation for _, partition, conversation in records if partition == "train"]
        selection = [
            conversation for _, partition, conversation in records if partition == "selection"
        ]
        random.Random(self.shuffle_seed).shuffle(train)
        if not train:
            raise ValueError("empty training partition")
        return (
            InMemorySupervisedDataset(train, self.common_config.batch_size, self.to_datum),
            InMemorySupervisedDataset(selection, len(selection), self.to_datum)
            if selection
            else None,
        )
