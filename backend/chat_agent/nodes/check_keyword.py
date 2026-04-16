from __future__ import annotations

from typing import Any

from .shared import ensure_state, has_domain_tool_result, infer_category_from_query, parse_classification

CLASSIFICATION_SYSTEM_PROMPT = """
You classify the latest user request for an assistant workflow.

Return JSON only:
{"category":"meeting|email|general","reason":"short reason","confidence":0.0}

Rules:
- meeting: the user asks about meetings, meeting notes, transcripts, minutes, summaries, or action items.
- email: the user asks about email, inbox, Outlook, mail reading, mail reply, or mail analysis.
- general: everything else.
- Choose exactly one category.
""".strip()


async def check_keyword(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)

    if has_domain_tool_result(resolved.messages, "meeting"):
        return {
            "selected_domain": "meeting",
            "classification_reason": "meeting tool result already present",
        }

    if has_domain_tool_result(resolved.messages, "email"):
        return {
            "selected_domain": "email",
            "classification_reason": "email tool result already present",
        }

    if not resolved.latest_user_query:
        return {
            "selected_domain": "general",
            "classification_reason": "latest user query is empty",
        }

    try:
        result = await resolved.provider.invoke_turn(
            model=resolved.model,
            system_prompt=CLASSIFICATION_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": resolved.latest_user_query}],
            tools=[],
            max_tokens=120,
        )
        classification = parse_classification(result.text, resolved.latest_user_query)
    except Exception:
        classification = infer_category_from_query(resolved.latest_user_query)

    return {
        "selected_domain": classification.category,
        "classification_reason": classification.reason,
    }
