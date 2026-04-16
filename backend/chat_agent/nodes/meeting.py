from __future__ import annotations

from typing import Any

from .shared import append_system_prompt, ensure_state, has_domain_tool_result, invoke_provider

MEETING_SYSTEM_PROMPT = """
This turn is about meeting data.

Guidelines:
- Use meeting tools when you need concrete meeting data.
- Start with `meeting_sessions` when you need to discover recent sessions.
- Use `meeting_transcript` only when you need the transcript for a specific sessionId.
- If meeting tool results are already present in the conversation, answer from them unless key information is still missing.
- Be explicit when a sessionId or transcript is missing.
""".strip()


async def handle_meeting(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    tool_results_exist = has_domain_tool_result(resolved.messages, "meeting")
    tool_names = ", ".join(tool["name"] for tool in resolved.available_meeting_tools) or "none"
    guidance = append_system_prompt(
        resolved.system_prompt,
        f"{MEETING_SYSTEM_PROMPT}\nAvailable meeting tools: {tool_names}\nExisting meeting tool result: {'yes' if tool_results_exist else 'no'}",
    )
    return await invoke_provider(
        resolved,
        system_prompt=guidance,
        tools=resolved.available_meeting_tools,
    )
