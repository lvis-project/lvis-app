from __future__ import annotations

import inspect
from typing import Any, Callable

try:
    from langgraph.graph import END, START, StateGraph  # type: ignore
except ImportError:
    START = "__start__"
    END = "__end__"

    class _CompiledGraph:
        def __init__(self, nodes: dict[str, Callable[..., Any]], edges: dict[str, list[str]]) -> None:
            self._nodes = nodes
            self._edges = edges

        async def ainvoke(self, state: dict[str, Any]) -> dict[str, Any]:
            current = START
            while True:
                next_nodes = self._edges.get(current, [])
                if not next_nodes:
                    return state
                next_node = next_nodes[0]
                if next_node == END:
                    return state
                update = self._nodes[next_node](state)
                if inspect.isawaitable(update):
                    update = await update
                if update:
                    state.update(update)
                current = next_node

    class StateGraph:
        def __init__(self, _state_type: Any) -> None:
            self._nodes: dict[str, Callable[..., Any]] = {}
            self._edges: dict[str, list[str]] = {}

        def add_node(self, name: str, fn: Callable[..., Any]) -> None:
            self._nodes[name] = fn

        def add_edge(self, source: str, target: str) -> None:
            self._edges.setdefault(source, []).append(target)

        def compile(self) -> _CompiledGraph:
            return _CompiledGraph(self._nodes, self._edges)
