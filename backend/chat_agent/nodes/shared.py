from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

from prompt_loader import load_prompt
from schemas import (
    ChatGraphState,
    ClassificationResult,
    DomainCategory,
    PluginCategorySpec,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
PLUGINS_DIR = PROJECT_ROOT / "plugins"
PLUGIN_REGISTRY_PATH = PLUGINS_DIR / "registry.json"

PLUGIN_TOOL_ALIASES: dict[str, tuple[str, ...]] = {
    "pageindex": (
        "knowledge_search",
        "document_list",
        "document_structure",
        "document_page_content",
    ),
}

PLUGIN_CLASSIFICATION_NOTES: dict[str, str] = {
    "meeting": "Use for meeting notes, transcripts, minutes, summaries, or action items after or during a meeting.",
    "email": "Use for inbox, email reading, replying, sent mail, Outlook mail, or mail analysis.",
    "calendar": "Use for schedules, events, meeting-room reservation, room availability, booking a room, or creating/updating calendar events.",
    "pageindex": "Use for searching documents, looking up indexed files, knowledge search, or reading document content.",
}


def ensure_state(state: ChatGraphState | dict[str, Any]) -> ChatGraphState:
    if isinstance(state, ChatGraphState):
        return state
    return ChatGraphState.model_validate(state)


def latest_user_query(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user" and message.get("content"):
            return str(message["content"])
    return ""


def filter_tools(
    tools: list[dict[str, Any]], allowed_names: Iterable[str]
) -> list[dict[str, Any]]:
    allowed = set(allowed_names)
    return [tool for tool in tools if str(tool.get("name", "")) in allowed]


def load_plugin_categories() -> list[PluginCategorySpec]:
    if not PLUGIN_REGISTRY_PATH.exists():
        return []

    try:
        registry = json.loads(PLUGIN_REGISTRY_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []

    categories: list[PluginCategorySpec] = []
    for entry in registry.get("plugins", []):
        if not entry.get("enabled", True):
            continue

        manifest_path = PLUGINS_DIR / str(entry.get("manifestPath", ""))
        if not manifest_path.exists():
            continue

        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue

        category_id = str(manifest.get("id") or entry.get("id") or "").strip().lower()
        if not category_id:
            continue

        name = str(manifest.get("name") or category_id).strip() or category_id
        description = first_non_empty_text(
            manifest.get("description"),
            *(
                ui.get("description")
                for ui in manifest.get("ui", [])
                if isinstance(ui, dict)
            ),
            *(ui.get("title") for ui in manifest.get("ui", []) if isinstance(ui, dict)),
            *(
                ui.get("displayName")
                for ui in manifest.get("ui", [])
                if isinstance(ui, dict)
            ),
        )

        method_names = [
            str(method).replace(".", "_")
            for method in manifest.get("methods", [])
            if isinstance(method, str) and method.strip()
        ]
        tool_names = dedupe_preserve_order(
            [*method_names, *PLUGIN_TOOL_ALIASES.get(category_id, ())]
        )

        categories.append(
            PluginCategorySpec(
                id=category_id,
                name=name,
                description=description,
                tool_names=tool_names,
                keywords=[],
            )
        )

    return categories


def has_domain_tool_result(
    messages: list[dict[str, Any]],
    domain: DomainCategory,
    plugin_categories: list[PluginCategorySpec],
) -> bool:
    tool_names = set(get_plugin_tool_names(plugin_categories, domain))
    if not tool_names:
        return False

    for message in reversed(messages):
        if message.get("role") == "user":
            return False
        if message.get("role") != "tool_result":
            continue
        tool_name = str(message.get("toolName") or "").strip()
        if tool_name in tool_names:
            return True
    return False


def append_system_prompt(base_prompt: str, addition: str) -> str:
    return f"{base_prompt.rstrip()}\n\n{addition.strip()}"


async def invoke_provider(
    state: ChatGraphState,
    *,
    system_prompt: str,
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    result = await state.provider.invoke_turn(
        model=state.model,
        system_prompt=system_prompt,
        messages=state.messages,
        tools=tools,
        max_tokens=state.max_tokens,
    )
    return {
        "active_tools": tools,
        "provider_result": result,
    }


def normalize_category(
    value: str | None, plugin_categories: list[PluginCategorySpec]
) -> DomainCategory | None:
    if not value:
        return None

    normalized = value.strip().lower()
    if normalized == "general":
        return "general"

    for category in plugin_categories:
        if normalized == category.id:
            return category.id
        if normalized == category.name.strip().lower():
            return category.id
    return None


def parse_classification(
    raw_text: str,
    _query: str,
    plugin_categories: list[PluginCategorySpec],
) -> ClassificationResult:
    stripped = raw_text.strip()
    if not stripped:
        return ClassificationResult(
            category="general", reason="classification unavailable"
        )

    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict):
        category = normalize_category(
            str(payload.get("category") or ""), plugin_categories
        )
        if category:
            confidence = payload.get("confidence")
            return ClassificationResult(
                category=category,
                reason=str(payload.get("reason") or "").strip() or None,
                confidence=(
                    float(confidence) if isinstance(confidence, (int, float)) else None
                ),
            )

    category = normalize_category(stripped, plugin_categories)
    if category:
        return ClassificationResult(
            category=category, reason="plain-text classification"
        )

    return ClassificationResult(
        category="general", reason="unrecognized classification output"
    )


def route_branch(state: ChatGraphState | dict[str, Any]) -> str:
    resolved = ensure_state(state)
    return "general" if resolved.selected_domain == "general" else "plugin"


def get_plugin_tool_names(
    plugin_categories: list[PluginCategorySpec], category_id: str
) -> list[str]:
    for category in plugin_categories:
        if category.id == category_id:
            return category.tool_names
    return []


def get_plugin_spec(
    plugin_categories: list[PluginCategorySpec], category_id: str
) -> PluginCategorySpec | None:
    for category in plugin_categories:
        if category.id == category_id:
            return category
    return None


def build_classification_prompt(plugin_categories: list[PluginCategorySpec]) -> str:
    category_lines = []
    for category in plugin_categories:
        tool_names = ", ".join(category.tool_names[:8]) or "none"
        description = category.description or category.name
        note = PLUGIN_CLASSIFICATION_NOTES.get(category.id, "")
        category_lines.append(
            f'- "{category.id}": {description}. {note} Tools: {tool_names}.'
        )

    categories_block = (
        "\n".join(category_lines)
        if category_lines
        else '- "general": default category.'
    )
    valid_categories = ", ".join(
        [*(category.id for category in plugin_categories), "general"]
    )
    return load_prompt(
        "routing/classify_category",
        {
            "valid_categories": valid_categories,
            "categories_block": categories_block,
        },
    )


def first_non_empty_text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str):
            text = value.strip()
            if text:
                return text
    return None


def dedupe_preserve_order(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result
