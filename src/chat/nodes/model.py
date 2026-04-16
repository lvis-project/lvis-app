from __future__ import annotations

from typing import Any


async def invoke_model(state: dict[str, Any]) -> dict[str, Any]:
    provider = state["provider"]
    result = await provider.invoke_turn(
        model=state["model"],
        system_prompt=state["system_prompt"],
        messages=state["messages"],
        tools=state["tools"],
        max_tokens=state["max_tokens"],
    )
    return {"provider_result": result}
