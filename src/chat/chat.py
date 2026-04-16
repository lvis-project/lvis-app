from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from langgraph_compat import END, START, StateGraph  # noqa: E402
from nodes import finalize_turn, invoke_model, prepare_turn  # noqa: E402
from providers import ProviderHttpError, build_provider  # noqa: E402


class ToolSchemaModel(BaseModel):
    name: str
    description: str
    inputSchema: dict[str, Any] = Field(default_factory=dict)


class MessageModel(BaseModel):
    role: str
    content: str | None = None
    thought: str | None = None
    toolCalls: list[dict[str, Any]] | None = None
    toolUseId: str | None = None
    toolName: str | None = None
    isError: bool | None = None


class ChatTurnRequest(BaseModel):
    vendor: str
    apiKey: str
    model: str
    systemPrompt: str
    messages: list[MessageModel]
    tools: list[ToolSchemaModel] = Field(default_factory=list)
    maxTokens: int = 4096


class ChatTurnResponse(BaseModel):
    text: str
    thought: str | None = None
    toolCalls: list[dict[str, Any]] = Field(default_factory=list)
    stopReason: str
    usage: dict[str, int] | None = None


def build_graph():
    graph = StateGraph(dict)
    graph.add_node("prepare", prepare_turn)
    graph.add_node("model", invoke_model)
    graph.add_node("finalize", finalize_turn)
    graph.add_edge(START, "prepare")
    graph.add_edge("prepare", "model")
    graph.add_edge("model", "finalize")
    graph.add_edge("finalize", END)
    return graph.compile()


GRAPH = build_graph()
app = FastAPI(title="LVIS LangGraph Chat Service")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"ok": "true"}


@app.post("/chat/turn", response_model=ChatTurnResponse)
async def chat_turn(request: ChatTurnRequest) -> ChatTurnResponse:
    try:
        provider = build_provider(request.vendor, request.apiKey)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    state = {
        "provider": provider,
        "model": request.model,
        "system_prompt": request.systemPrompt,
        "messages": [message.model_dump(exclude_none=True) for message in request.messages],
        "tools": [tool.model_dump() for tool in request.tools],
        "max_tokens": request.maxTokens,
    }

    try:
        result = await GRAPH.ainvoke(state)
    except ProviderHttpError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail=str(error)) from error

    return ChatTurnResponse(**result["response"])


@app.post("/shutdown")
async def shutdown() -> dict[str, bool]:
    loop = asyncio.get_running_loop()
    loop.call_later(0.1, lambda: os._exit(0))
    return {"ok": True}


def main() -> None:
    parser = argparse.ArgumentParser(description="LVIS Python LangGraph chat service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=43131)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
