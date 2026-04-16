from __future__ import annotations

from typing import Any

from .shared import ensure_state

def finalize_turn(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    result = resolved.provider_result
    if result is None:
        raise ValueError("provider_result is missing from graph state")

    return {
        "response": {
            "text": result.text,
            "thought": result.thought,
            "toolCalls": result.tool_calls,
            "stopReason": result.stop_reason,
            "usage": result.usage,
        }
    }
