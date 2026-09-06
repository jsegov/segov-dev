"""Full offline preflight using the actual training overrides.

Optional limit=0..100 bounds metadata-only train/selection previews AFTER every
row passes preflight. It never reduces validation or changes the saved preflight
identity. The default limit=0 prints only aggregate metadata. Previews contain
no raw messages, tool payloads, or final-partition targets.
"""
import json
import sys
from ama_training.train import resolve_config
from ama_training.preflight import run_preflight
from ama_training.provenance import digest

MAX_PREVIEW_ROWS = 100


def parse_preview_limit(value):
    if not value.isascii() or not value.isdecimal():
        raise ValueError(f"limit must be an integer between 0 and {MAX_PREVIEW_ROWS}")
    limit = int(value)
    if limit > MAX_PREVIEW_ROWS:
        raise ValueError(f"limit must be an integer between 0 and {MAX_PREVIEW_ROWS}")
    return limit


def preview_metadata(builder, limit):
    """Summarize at most limit already-validated non-final examples without text."""
    if not limit:
        return []
    previews = []
    for row, partition, conversation in builder.conversations_with_metadata():
        if partition == "final":
            continue
        previews.append(
            {
                "example_sha256": digest(row),
                "partition": partition,
                "prompt_version": row["system_prompt_version"],
                "message_count": len(conversation),
            }
        )
        if len(previews) == limit:
            break
    return previews


def main(argv):
    output = None
    limit = 0
    args = []
    seen = set()
    for arg in argv:
        key = arg.partition("=")[0]
        if key in {"output", "limit"}:
            if key in seen:
                raise ValueError(f"duplicate {key}= option")
            seen.add(key)
        if arg.startswith("output="):
            output = arg.split("=", 1)[1]
        elif arg.startswith("limit="):
            limit = parse_preview_limit(arg.split("=", 1)[1])
        else:
            args.append(arg)
    _, config = resolve_config(args, resume=True)
    report = run_preflight(config, output)
    print(
        f"Validated {report['validated_rows']} rows, rendered {report['rendered_rows']} train/selection rows: {report['counts']}; max tokens={report['max_tokens']}; preflight={report['artifact_sha256']}"
    )
    for preview in preview_metadata(config.dataset_builder, limit):
        print(f"Preview: {json.dumps(preview, sort_keys=True)}")
    return report


if __name__ == "__main__":
    main(sys.argv[1:])
