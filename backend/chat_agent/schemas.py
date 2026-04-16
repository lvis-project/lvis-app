from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field

DomainCategory = str


class ClassificationResult(BaseModel):
    category: DomainCategory
    reason: str | None = None
    confidence: float | None = None


class PluginCategorySpec(BaseModel):
    id: str
    name: str
    description: str | None = None
    tool_names: list[str] = Field(default_factory=list)
    keywords: list[str] = Field(default_factory=list)


class PluginRequest(BaseModel):
    request_id: str
    plugin: str
    action: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)


class PluginResponse(BaseModel):
    request_id: str
    plugin: str
    action: str
    ok: bool
    data: Any = None
    error: str | None = None
    meta: dict[str, Any] = Field(default_factory=dict)


class ChatGraphState(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)

    provider: Any
    model: str
    system_prompt: str
    messages: list[dict[str, Any]] = Field(default_factory=list)
    tools: list[dict[str, Any]] = Field(default_factory=list)
    max_tokens: int = 4096
    latest_user_query: str = ""
    selected_domain: DomainCategory = "general"
    classification_reason: str | None = None
    plugin_categories: list[PluginCategorySpec] = Field(default_factory=list)
    available_plugin_tools: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    active_tools: list[dict[str, Any]] = Field(default_factory=list)
    provider_result: Any | None = None
    response: dict[str, Any] | None = None
