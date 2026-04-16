from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DomainCategory = Literal["meeting", "email", "general"]


class ClassificationResult(BaseModel):
    category: DomainCategory
    reason: str | None = None
    confidence: float | None = None


class PluginRequest(BaseModel):
    request_id: str
    plugin: Literal["meeting", "email"]
    action: str
    arguments: dict[str, Any] = Field(default_factory=dict)
    context: dict[str, Any] = Field(default_factory=dict)


class PluginResponse(BaseModel):
    request_id: str
    plugin: Literal["meeting", "email"]
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
    available_meeting_tools: list[dict[str, Any]] = Field(default_factory=list)
    available_email_tools: list[dict[str, Any]] = Field(default_factory=list)
    active_tools: list[dict[str, Any]] = Field(default_factory=list)
    provider_result: Any | None = None
    response: dict[str, Any] | None = None
