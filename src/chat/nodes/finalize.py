from __future__ import annotations

from typing import Any


def finalize_turn(state: dict[str, Any]) -> dict[str, Any]:
    result = state["provider_result"]
    return {
        "response": {
            "text": result.text,
            "thought": result.thought,
            "toolCalls": result.tool_calls,
            "stopReason": result.stop_reason,
            "usage": result.usage,
        }
    }
