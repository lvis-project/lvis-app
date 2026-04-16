from __future__ import annotations

from typing import Any

from .shared import append_system_prompt, ensure_state, has_domain_tool_result, invoke_provider

EMAIL_SYSTEM_PROMPT = """
This turn is about email data.

Guidelines:
- Use email tools when you need mailbox or message data.
- Start with `email_status` when authentication state may matter.
- Use `email_list` to discover messages, then `email_read` for a specific message.
- Use `email_analyze` when the user needs an analysis or action summary for one email.
- If email tool results are already present in the conversation, answer from them unless key information is still missing.
- If authentication is required, say so clearly.
""".strip()


async def handle_email(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    tool_results_exist = has_domain_tool_result(resolved.messages, "email")
    tool_names = ", ".join(tool["name"] for tool in resolved.available_email_tools) or "none"
    guidance = append_system_prompt(
        resolved.system_prompt,
        f"{EMAIL_SYSTEM_PROMPT}\nAvailable email tools: {tool_names}\nExisting email tool result: {'yes' if tool_results_exist else 'no'}",
    )
    return await invoke_provider(
        resolved,
        system_prompt=guidance,
        tools=resolved.available_email_tools,
    )
