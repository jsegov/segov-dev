"""Prompt-manifest loading.

The trace exporter writes prompt-manifest.json mapping each
system_prompt_version (content hash) to the exact instructions, tool
declarations, and call settings that produced those traces. Training must
rebuild the conversation prefix from this snapshot — never from current
frontend code — so older traces keep the prompt they were generated with.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from tinker_cookbook.renderers import ToolSpec


@dataclass(frozen=True)
class PromptVersion:
    version: str
    system_prompt: str
    tools: list[ToolSpec]


def load_manifest(path: str | Path) -> dict[str, PromptVersion]:
    raw = json.loads(Path(path).read_text())
    versions: dict[str, PromptVersion] = {}
    for version, entry in raw.items():
        tools = [
            ToolSpec(
                name=declaration["name"],
                description=declaration["description"],
                parameters=declaration["inputSchema"],
            )
            for declaration in entry["tool_declarations"]
        ]
        versions[version] = PromptVersion(
            version=version,
            system_prompt=entry["instructions"],
            tools=tools,
        )
    return versions
