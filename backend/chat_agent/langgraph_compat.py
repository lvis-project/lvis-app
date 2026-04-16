from __future__ import annotations

import inspect
from typing import Any, Callable

try:
    from langgraph.graph import END, START, StateGraph  # type: ignore
except ImportError:
    from pydantic import BaseModel

    START = "__start__"
    END = "__end__"

    class _CompiledGraph:
        def __init__(
            self,
            nodes: dict[str, Callable[..., Any]],
            edges: dict[str, list[str]],
            conditional_edges: dict[str, tuple[Callable[..., Any], dict[str, str]]],
        ) -> None:
            self._nodes = nodes
            self._edges = edges
            self._conditional_edges = conditional_edges

        async def ainvoke(self, state: Any) -> Any:
            current = START
            while True:
                if current in self._conditional_edges:
                    router, mapping = self._conditional_edges[current]
                    route = router(state)
                    if inspect.isawaitable(route):
                        route = await route
                    next_node = mapping.get(route, route)
                else:
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
                    if isinstance(state, BaseModel):
                        state = state.model_copy(update=update)
                    else:
                        state.update(update)
                current = next_node

    class StateGraph:
        def __init__(self, _state_type: Any) -> None:
            self._nodes: dict[str, Callable[..., Any]] = {}
            self._edges: dict[str, list[str]] = {}
            self._conditional_edges: dict[str, tuple[Callable[..., Any], dict[str, str]]] = {}

        def add_node(self, name: str, fn: Callable[..., Any]) -> None:
            self._nodes[name] = fn

        def add_edge(self, source: str, target: str) -> None:
            self._edges.setdefault(source, []).append(target)

        def add_conditional_edges(
            self,
            source: str,
            path: Callable[..., Any],
            path_map: dict[str, str],
        ) -> None:
            self._conditional_edges[source] = (path, path_map)

        def compile(self) -> _CompiledGraph:
            return _CompiledGraph(self._nodes, self._edges, self._conditional_edges)
