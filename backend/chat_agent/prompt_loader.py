from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import re

DEFAULT_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"
USER_PROMPTS_DIR = Path.home() / ".lvis" / "prompts"
PLACEHOLDER_PATTERN = re.compile(r"\{\{\s*([a-zA-Z0-9_]+)\s*\}\}")


@dataclass(frozen=True)
class PromptMeta:
    id: str
    version: int
    description: str
    variables: list[str]
    enabled: bool = True


def load_prompt(prompt_id: str, variables: dict[str, str] | None = None) -> str:
    meta = load_prompt_meta(prompt_id)
    if not meta.enabled:
        raise ValueError(f"prompt '{prompt_id}' is disabled")

    prompt_path = _resolve_prompt_path(prompt_id)
    template = prompt_path.read_text(encoding="utf-8").strip()
    values = variables or {}
    missing = [name for name in meta.variables if name not in values]
    if missing:
        raise ValueError(f"prompt '{prompt_id}' missing variables: {', '.join(missing)}")

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values:
            raise ValueError(f"prompt '{prompt_id}' missing placeholder value: {name}")
        return str(values[name])

    return PLACEHOLDER_PATTERN.sub(replace, template)


def load_prompt_meta(prompt_id: str) -> PromptMeta:
    meta_path = _resolve_meta_path(prompt_id)
    payload = _parse_simple_yaml(meta_path.read_text(encoding="utf-8"))

    prompt_meta = PromptMeta(
        id=str(payload.get("id") or prompt_id),
        version=int(payload.get("version", 1)),
        description=str(payload.get("description") or ""),
        variables=[str(item) for item in payload.get("variables", [])],
        enabled=bool(payload.get("enabled", True)),
    )
    if prompt_meta.id != prompt_id:
        raise ValueError(f"prompt metadata id mismatch for '{prompt_id}': {prompt_meta.id}")
    return prompt_meta


def _resolve_prompt_path(prompt_id: str) -> Path:
    return _resolve_path(prompt_id, ".prompt.md")


def _resolve_meta_path(prompt_id: str) -> Path:
    return _resolve_path(prompt_id, ".meta.yaml")


def _resolve_path(prompt_id: str, suffix: str) -> Path:
    relative = Path(*prompt_id.split("/"))
    override_path = USER_PROMPTS_DIR / relative.with_suffix(suffix)
    if override_path.exists():
        return override_path
    default_path = DEFAULT_PROMPTS_DIR / relative.with_suffix(suffix)
    if default_path.exists():
        return default_path
    raise FileNotFoundError(f"prompt '{prompt_id}' not found for suffix '{suffix}'")


def _parse_simple_yaml(raw: str) -> dict[str, object]:
    data: dict[str, object] = {}
    current_list_key: str | None = None

    for raw_line in raw.splitlines():
        line = raw_line.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        if line.startswith("  - "):
            if current_list_key is None:
                raise ValueError("yaml list item found without active key")
            items = data.setdefault(current_list_key, [])
            if not isinstance(items, list):
                raise ValueError(f"yaml key '{current_list_key}' is not a list")
            items.append(_parse_scalar(line[4:].strip()))
            continue

        current_list_key = None
        key, separator, value = line.partition(":")
        if separator != ":":
            raise ValueError(f"invalid yaml line: {line}")
        parsed_key = key.strip()
        parsed_value = value.strip()
        if not parsed_key:
            raise ValueError(f"invalid yaml key in line: {line}")
        if not parsed_value:
            data[parsed_key] = []
            current_list_key = parsed_key
            continue
        data[parsed_key] = _parse_scalar(parsed_value)

    return data


def _parse_scalar(value: str) -> object:
    if value == "[]":
        return []
    if value in {"true", "True"}:
        return True
    if value in {"false", "False"}:
        return False
    if value.isdigit():
        return int(value)
    if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
        return value[1:-1]
    return value
