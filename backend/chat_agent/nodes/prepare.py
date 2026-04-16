from __future__ import annotations

from typing import Any

from .shared import EMAIL_TOOL_NAMES, MEETING_TOOL_NAMES, ensure_state, filter_tools, latest_user_query


def prepare_turn(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    max_tokens = int(resolved.max_tokens or 4096)
    if max_tokens <= 0:
        max_tokens = 4096

    return {
        "messages": resolved.messages,
        "tools": resolved.tools,
        "max_tokens": max_tokens,
        "latest_user_query": latest_user_query(resolved.messages),
        "available_meeting_tools": filter_tools(resolved.tools, MEETING_TOOL_NAMES),
        "available_email_tools": filter_tools(resolved.tools, EMAIL_TOOL_NAMES),
    }
