from __future__ import annotations

from typing import Any

from .shared import append_system_prompt, ensure_state, invoke_provider

GENERAL_SYSTEM_PROMPT = """
This turn is general chat.

Guidelines:
- Answer directly from the conversation context.
- Do not rely on meeting or email plugin data in this branch.
- If the question is ambiguous, answer conservatively and mention uncertainty.
""".strip()


async def handle_general(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    guidance = append_system_prompt(resolved.system_prompt, GENERAL_SYSTEM_PROMPT)
    return await invoke_provider(
        resolved,
        system_prompt=guidance,
        tools=[],
    )
