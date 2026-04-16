from __future__ import annotations

import json
from typing import Any, Iterable

from schemas import ChatGraphState, ClassificationResult, DomainCategory

MEETING_TOOL_NAMES = {
    "meeting_sessions",
    "meeting_transcript",
}

EMAIL_TOOL_NAMES = {
    "email_status",
    "email_auth",
    "email_list",
    "email_read",
    "email_analyze",
    "email_getSentReplies",
    "email_getSentReply",
    "email_getNotifications",
}

MEETING_QUERY_TOKENS = (
    "\ud68c\uc758",
    "\ud68c\uc758\ub85d",
    "\ubbf8\ud305",
    "\ub179\ucde8",
    "\ud68c\uc758 \ub0b4\uc6a9",
    "meeting",
)

EMAIL_QUERY_TOKENS = (
    "\uba54\uc77c",
    "\uc774\uba54\uc77c",
    "outlook",
    "email",
)


def ensure_state(state: ChatGraphState | dict[str, Any]) -> ChatGraphState:
    if isinstance(state, ChatGraphState):
        return state
    return ChatGraphState.model_validate(state)


def latest_user_query(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user" and message.get("content"):
            return str(message["content"])
    return ""


def filter_tools(tools: list[dict[str, Any]], allowed_names: Iterable[str]) -> list[dict[str, Any]]:
    allowed = set(allowed_names)
    return [tool for tool in tools if tool.get("name") in allowed]


def has_domain_tool_result(messages: list[dict[str, Any]], domain: DomainCategory) -> bool:
    prefix = f"{domain}_"
    for message in reversed(messages):
        if message.get("role") == "user":
            return False
        if message.get("role") != "tool_result":
            continue
        tool_name = message.get("toolName") or ""
        if isinstance(tool_name, str) and tool_name.startswith(prefix):
            return True
    return False


def append_system_prompt(base_prompt: str, addition: str) -> str:
    return f"{base_prompt.rstrip()}\n\n{addition.strip()}"


async def invoke_provider(
    state: ChatGraphState,
    *,
    system_prompt: str,
    tools: list[dict[str, Any]],
) -> dict[str, Any]:
    result = await state.provider.invoke_turn(
        model=state.model,
        system_prompt=system_prompt,
        messages=state.messages,
        tools=tools,
        max_tokens=state.max_tokens,
    )
    return {
        "active_tools": tools,
        "provider_result": result,
    }


def normalize_category(value: str | None) -> DomainCategory | None:
    if not value:
        return None

    normalized = value.strip().lower()
    if normalized in {"meeting", "meetings", "minutes", "transcript", "conference"}:
        return "meeting"
    if normalized in {"email", "mail", "outlook", "inbox"}:
        return "email"
    if normalized in {"general", "other", "misc", "etc"}:
        return "general"
    if "meeting" in normalized or "minutes" in normalized or "transcript" in normalized:
        return "meeting"
    if "email" in normalized or "mail" in normalized or "outlook" in normalized:
        return "email"
    return None


def infer_category_from_query(query: str) -> ClassificationResult:
    lowered = query.lower()
    if any(token in query for token in MEETING_QUERY_TOKENS):
        return ClassificationResult(category="meeting", reason="query keyword fallback")
    if any(token in query for token in EMAIL_QUERY_TOKENS):
        return ClassificationResult(category="email", reason="query keyword fallback")
    if any(token in lowered for token in ("mail", "inbox", "message")):
        return ClassificationResult(category="email", reason="query keyword fallback")
    return ClassificationResult(category="general", reason="query keyword fallback")


def parse_classification(raw_text: str, query: str) -> ClassificationResult:
    stripped = raw_text.strip()
    if not stripped:
        return infer_category_from_query(query)

    try:
        payload = json.loads(stripped)
    except json.JSONDecodeError:
        payload = None

    if isinstance(payload, dict):
        category = normalize_category(str(payload.get("category") or ""))
        if category:
            confidence = payload.get("confidence")
            return ClassificationResult(
                category=category,
                reason=str(payload.get("reason") or "").strip() or None,
                confidence=float(confidence) if isinstance(confidence, (int, float)) else None,
            )

    category = normalize_category(stripped)
    if category:
        return ClassificationResult(category=category, reason="plain-text classification")

    return infer_category_from_query(query)


def route_domain(state: ChatGraphState | dict[str, Any]) -> DomainCategory:
    resolved = ensure_state(state)
    return resolved.selected_domain
