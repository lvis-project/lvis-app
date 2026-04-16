from __future__ import annotations

from typing import Any

from prompt_loader import load_prompt
from .shared import append_system_prompt, ensure_state, invoke_provider


async def handle_general(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    guidance = append_system_prompt(resolved.system_prompt, load_prompt("domains/general"))
    return await invoke_provider(
        resolved,
        system_prompt=guidance,
        tools=[],
    )
