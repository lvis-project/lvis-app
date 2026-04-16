from __future__ import annotations

import json
import asyncio
from dataclasses import dataclass
from typing import Any

import httpx


@dataclass
class ProviderTurnResult:
    text: str
    thought: str | None
    tool_calls: list[dict[str, Any]]
    stop_reason: str
    usage: dict[str, int] | None


class ProviderHttpError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class BaseProvider:
    async def invoke_turn(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
    ) -> ProviderTurnResult:
        raise NotImplementedError


async def request_json_with_retry(
    *,
    client: httpx.AsyncClient,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    max_attempts: int = 3,
) -> dict[str, Any]:
    delay = 1.0
    for attempt in range(1, max_attempts + 1):
        response = await client.request(method, url, headers=headers, json=json_body)
        if response.is_success:
            return response.json()

        detail = extract_error_detail(response)
        if response.status_code == 429 and attempt < max_attempts and is_retryable_rate_limit(detail):
            await asyncio.sleep(delay)
            delay *= 2
            continue

        raise ProviderHttpError(response.status_code, detail)

    raise ProviderHttpError(429, "LLM 요청이 반복적으로 rate limit에 걸렸습니다. 잠시 후 다시 시도해 주세요.")


def extract_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        payload = None

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message")
            if code == "insufficient_quota":
                return "OpenAI API 할당량이 소진되었습니다. 다른 provider를 선택하거나 API 키/플랜 상태를 확인해 주세요."
            if isinstance(message, str) and message.strip():
                if response.status_code == 429:
                    return f"OpenAI 요청 한도 초과: {message}"
                return message
        detail = payload.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail

    if response.status_code == 429:
        return "OpenAI 요청이 너무 많아 일시적으로 제한되었습니다. 잠시 후 다시 시도해 주세요."
    return f"Upstream provider error {response.status_code}: {response.text[:500]}"


def is_retryable_rate_limit(detail: str) -> bool:
    lowered = detail.lower()
    return "insufficient_quota" not in lowered and "quota" not in lowered


class OpenAICompatibleProvider(BaseProvider):
    def __init__(self, *, api_key: str, base_url: str) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")

    async def invoke_turn(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
    ) -> ProviderTurnResult:
        is_reasoning_model = any(token in model.lower() for token in ("o1", "o3", "reasoning"))
        use_max_completion_tokens = is_reasoning_model or any(
            token in model.lower() for token in ("gpt-4o", "gpt-4.5", "gpt-5")
        )
        payload: dict[str, Any] = {
            "model": model,
            "messages": to_openai_messages(system_prompt, messages, is_reasoning_model),
        }
        if tools:
            payload["tools"] = [to_openai_tool(tool) for tool in tools]
        if use_max_completion_tokens:
            payload["max_completion_tokens"] = max_tokens
        else:
            payload["max_tokens"] = max_tokens

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            data = await request_json_with_retry(
                client=client,
                method="POST",
                url=f"{self.base_url}/chat/completions",
                headers=headers,
                json_body=payload,
            )

        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        tool_calls: list[dict[str, Any]] = []
        for item in message.get("tool_calls") or []:
            arguments = item.get("function", {}).get("arguments") or "{}"
            try:
                parsed_arguments = json.loads(arguments)
            except json.JSONDecodeError:
                parsed_arguments = {}
            tool_calls.append({
                "id": item.get("id") or f"tool-{len(tool_calls)}",
                "name": item.get("function", {}).get("name") or "tool",
                "input": parsed_arguments,
            })

        usage = data.get("usage") or {}
        return ProviderTurnResult(
            text=message.get("content") or "",
            thought=message.get("reasoning_content"),
            tool_calls=tool_calls,
            stop_reason="tool_use" if tool_calls else "end_turn",
            usage={
                "inputTokens": int(usage.get("prompt_tokens", 0)),
                "outputTokens": int(usage.get("completion_tokens", 0)),
            },
        )


class ClaudeProvider(BaseProvider):
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def invoke_turn(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
    ) -> ProviderTurnResult:
        payload: dict[str, Any] = {
            "model": model,
            "max_tokens": max_tokens,
            "system": system_prompt,
            "messages": to_anthropic_messages(messages),
        }
        if tools:
            payload["tools"] = [to_anthropic_tool(tool) for tool in tools]

        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }

        async with httpx.AsyncClient(timeout=120.0) as client:
            data = await request_json_with_retry(
                client=client,
                method="POST",
                url="https://api.anthropic.com/v1/messages",
                headers=headers,
                json_body=payload,
            )

        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for block in data.get("content") or []:
            if block.get("type") == "text":
                text_parts.append(block.get("text", ""))
            elif block.get("type") == "tool_use":
                tool_calls.append({
                    "id": block.get("id") or f"tool-{len(tool_calls)}",
                    "name": block.get("name") or "tool",
                    "input": block.get("input") or {},
                })

        usage = data.get("usage") or {}
        return ProviderTurnResult(
            text="".join(text_parts).strip(),
            thought=None,
            tool_calls=tool_calls,
            stop_reason="tool_use" if data.get("stop_reason") == "tool_use" else "end_turn",
            usage={
                "inputTokens": int(usage.get("input_tokens", 0)),
                "outputTokens": int(usage.get("output_tokens", 0)),
            },
        )


class GeminiProvider(BaseProvider):
    def __init__(self, api_key: str) -> None:
        self.api_key = api_key

    async def invoke_turn(
        self,
        *,
        model: str,
        system_prompt: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        max_tokens: int,
    ) -> ProviderTurnResult:
        payload: dict[str, Any] = {
            "system_instruction": {"parts": [{"text": system_prompt}]},
            "contents": to_gemini_contents(messages),
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if tools:
            payload["tools"] = [{"function_declarations": [to_gemini_tool(tool) for tool in tools]}]

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={self.api_key}"
        async with httpx.AsyncClient(timeout=120.0) as client:
            data = await request_json_with_retry(
                client=client,
                method="POST",
                url=url,
                json_body=payload,
            )

        candidates = data.get("candidates") or []
        parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        for part in parts:
            if "text" in part:
                text_parts.append(part["text"])
            function_call = part.get("functionCall")
            if function_call:
                tool_calls.append({
                    "id": f"gemini-{len(tool_calls)}-{function_call.get('name', 'tool')}",
                    "name": function_call.get("name") or "tool",
                    "input": function_call.get("args") or {},
                })

        usage = data.get("usageMetadata") or {}
        return ProviderTurnResult(
            text="".join(text_parts).strip(),
            thought=None,
            tool_calls=tool_calls,
            stop_reason="tool_use" if tool_calls else "end_turn",
            usage={
                "inputTokens": int(usage.get("promptTokenCount", 0)),
                "outputTokens": int(usage.get("candidatesTokenCount", 0)),
            },
        )


def build_provider(vendor: str, api_key: str) -> BaseProvider:
    if vendor == "claude":
        return ClaudeProvider(api_key)
    if vendor == "openai":
        return OpenAICompatibleProvider(api_key=api_key, base_url="https://api.openai.com/v1")
    if vendor == "copilot":
        return OpenAICompatibleProvider(api_key=api_key, base_url="https://models.github.ai/inference")
    if vendor == "gemini":
        return GeminiProvider(api_key)
    raise ValueError(f"Unsupported vendor for Python chat runtime: {vendor}")


def to_openai_messages(system_prompt: str, messages: list[dict[str, Any]], is_reasoning_model: bool) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = [
        {"role": "developer" if is_reasoning_model else "system", "content": system_prompt}
    ]
    for message in messages:
        role = message["role"]
        if role == "user":
            result.append({"role": "user", "content": message["content"]})
        elif role == "assistant":
            assistant_message: dict[str, Any] = {
                "role": "assistant",
                "content": message.get("content") or None,
            }
            if message.get("toolCalls"):
                assistant_message["tool_calls"] = [
                    {
                        "id": tool_call["id"],
                        "type": "function",
                        "function": {
                            "name": tool_call["name"],
                            "arguments": json.dumps(tool_call["input"], ensure_ascii=False),
                        },
                    }
                    for tool_call in message["toolCalls"]
                ]
            if is_reasoning_model and message.get("thought") is not None:
                assistant_message["reasoning_content"] = message["thought"]
            result.append(assistant_message)
        elif role == "tool_result":
            result.append({
                "role": "tool",
                "tool_call_id": message["toolUseId"],
                "content": message["content"],
            })
    return result


def to_openai_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["inputSchema"],
        },
    }


def to_anthropic_messages(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        role = message["role"]
        if role == "user":
            result.append({"role": "user", "content": message["content"]})
        elif role == "assistant":
            content: list[dict[str, Any]] = []
            if message.get("content"):
                content.append({"type": "text", "text": message["content"]})
            for tool_call in message.get("toolCalls") or []:
                content.append({
                    "type": "tool_use",
                    "id": tool_call["id"],
                    "name": tool_call["name"],
                    "input": tool_call["input"],
                })
            result.append({"role": "assistant", "content": content})
        elif role == "tool_result":
            result.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": message["toolUseId"],
                    "content": message["content"],
                    **({"is_error": True} if message.get("isError") else {}),
                }],
            })
    return result


def to_anthropic_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": tool["name"],
        "description": tool["description"],
        "input_schema": tool["inputSchema"],
    }


def to_gemini_contents(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for message in messages:
        role = message["role"]
        if role == "user":
            result.append({"role": "user", "parts": [{"text": message["content"]}]})
        elif role == "assistant":
            parts: list[dict[str, Any]] = []
            if message.get("content"):
                parts.append({"text": message["content"]})
            for tool_call in message.get("toolCalls") or []:
                parts.append({"functionCall": {"name": tool_call["name"], "args": tool_call["input"]}})
            result.append({"role": "model", "parts": parts})
        elif role == "tool_result":
            result.append({
                "role": "user",
                "parts": [{
                    "functionResponse": {
                        "name": message.get("toolName") or "tool",
                        "response": {"result": message["content"]},
                    }
                }],
            })
    return result


def to_gemini_tool(tool: dict[str, Any]) -> dict[str, Any]:
    return {
        "name": tool["name"],
        "description": tool["description"],
        "parameters": tool["inputSchema"],
    }
