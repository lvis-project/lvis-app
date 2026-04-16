from __future__ import annotations

from typing import Any

from prompt_loader import load_prompt
from .shared import (
    append_system_prompt,
    ensure_state,
    get_plugin_spec,
    has_domain_tool_result,
    invoke_provider,
)


async def handle_plugin_domain(state: dict[str, Any]) -> dict[str, Any]:
    resolved = ensure_state(state)
    category = get_plugin_spec(resolved.plugin_categories, resolved.selected_domain)
    active_tools = resolved.available_plugin_tools.get(resolved.selected_domain, [])
    tool_results_exist = has_domain_tool_result(
        resolved.messages,
        resolved.selected_domain,
        resolved.plugin_categories,
    )

    category_name = category.name if category else resolved.selected_domain
    category_description = category.description if category and category.description else "plugin-backed workflow"
    tool_names = ", ".join(tool["name"] for tool in active_tools) or "none"
    guidance = append_system_prompt(
        resolved.system_prompt,
        load_prompt(
            "domains/plugin_domain",
            {
                "category_name": category_name,
                "selected_domain": resolved.selected_domain,
                "category_description": category_description,
                "tool_names": tool_names,
                "tool_results_exist": "yes" if tool_results_exist else "no",
            },
        ),
    )
    return await invoke_provider(
        resolved,
        system_prompt=guidance,
        tools=active_tools,
    )
