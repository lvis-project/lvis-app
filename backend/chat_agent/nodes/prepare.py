from __future__ import annotations

from typing import Any

from .shared import ensure_state, filter_tools, latest_user_query, load_plugin_categories


def prepare_turn(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    max_tokens = int(resolved.max_tokens or 4096)
    if max_tokens <= 0:
        max_tokens = 4096

    plugin_categories = load_plugin_categories()
    available_plugin_tools = {
        category.id: filter_tools(resolved.tools, category.tool_names)
        for category in plugin_categories
    }

    return {
        "messages": resolved.messages,
        "tools": resolved.tools,
        "max_tokens": max_tokens,
        "latest_user_query": latest_user_query(resolved.messages),
        "plugin_categories": plugin_categories,
        "available_plugin_tools": available_plugin_tools,
    }
