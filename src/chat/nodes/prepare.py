from __future__ import annotations

from typing import Any


def prepare_turn(state: dict[str, Any]) -> dict[str, Any]:
    max_tokens = int(state.get("max_tokens") or 4096)
    if max_tokens <= 0:
        max_tokens = 4096

    return {
        "messages": state.get("messages") or [],
        "tools": state.get("tools") or [],
        "max_tokens": max_tokens,
    }
