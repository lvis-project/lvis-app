from __future__ import annotations

from typing import Any
from .shared import (
    build_classification_prompt,
    ensure_state,
    has_domain_tool_result,
    parse_classification,
)


async def check_keyword(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    categories = resolved.plugin_categories

    for category in categories:
        if has_domain_tool_result(resolved.messages, category.id, categories):
            return {
                "selected_domain": category.id,
                "classification_reason": f"{category.id} tool result already present",
            }

    if not resolved.latest_user_query:
        return {
            "selected_domain": "general",
            "classification_reason": "latest user query is empty",
        }

    try:
        result = await resolved.provider.invoke_turn(
            model=resolved.model,
            system_prompt=build_classification_prompt(categories),
            messages=[{"role": "user", "content": resolved.latest_user_query}],
            tools=[],
            max_tokens=120,
        )
        classification = parse_classification(result.text, resolved.latest_user_query, categories)
    except Exception:
        classification = parse_classification("", resolved.latest_user_query, categories)

    return {
        "selected_domain": classification.category,
        "classification_reason": classification.reason,
    }
