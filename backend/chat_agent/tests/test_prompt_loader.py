from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
import sys

CHAT_AGENT_DIR = Path(__file__).resolve().parents[1]
if str(CHAT_AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(CHAT_AGENT_DIR))

import prompt_loader
from nodes.general import handle_general
from nodes.plugin_domain import handle_plugin_domain
from nodes.shared import build_classification_prompt
from schemas import ChatGraphState, PluginCategorySpec


class DummyResult:
    def __init__(self) -> None:
        self.text = "ok"
        self.thought = None
        self.tool_calls: list[dict[str, object]] = []
        self.stop_reason = "end_turn"
        self.usage = {"inputTokens": 1, "outputTokens": 1}


class DummyProvider:
    def __init__(self) -> None:
        self.system_prompt = ""

    async def invoke_turn(self, **kwargs: object) -> DummyResult:
        self.system_prompt = str(kwargs["system_prompt"])
        return DummyResult()


class PromptLoaderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.original_user_dir = prompt_loader.USER_PROMPTS_DIR
        self.temp_dir = tempfile.TemporaryDirectory()
        prompt_loader.USER_PROMPTS_DIR = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        prompt_loader.USER_PROMPTS_DIR = self.original_user_dir
        self.temp_dir.cleanup()

    def test_loads_repo_default_prompt(self) -> None:
        text = prompt_loader.load_prompt(
            "routing/classify_category",
            {
                "valid_categories": "meeting, general",
                "categories_block": '- "meeting": Meeting tools.',
            },
        )
        self.assertIn("meeting, general", text)
        self.assertIn("Meeting tools.", text)

    def test_prefers_user_override_prompt(self) -> None:
        override_meta = prompt_loader.USER_PROMPTS_DIR / "routing" / "classify_category.meta.yaml"
        override_prompt = prompt_loader.USER_PROMPTS_DIR / "routing" / "classify_category.prompt.md"
        override_meta.parent.mkdir(parents=True, exist_ok=True)
        override_meta.write_text(
            "\n".join(
                [
                    "id: routing/classify_category",
                    "version: 1",
                    "description: Override",
                    "variables:",
                    "  - valid_categories",
                    "enabled: true",
                ]
            ),
            encoding="utf-8",
        )
        override_prompt.write_text("override {{valid_categories}}", encoding="utf-8")

        text = prompt_loader.load_prompt(
            "routing/classify_category",
            {"valid_categories": "general"},
        )
        self.assertEqual(text, "override general")

    def test_missing_required_variable_fails(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing variables"):
            prompt_loader.load_prompt("routing/classify_category", {"valid_categories": "general"})

    def test_load_prompt_meta_returns_expected_shape(self) -> None:
        meta = prompt_loader.load_prompt_meta("domains/plugin_domain")
        self.assertEqual(meta.id, "domains/plugin_domain")
        self.assertTrue(meta.enabled)
        self.assertIn("category_name", meta.variables)

    def test_classification_prompt_still_builds(self) -> None:
        prompt = build_classification_prompt(
            [
                PluginCategorySpec(
                    id="meeting",
                    name="Meeting",
                    description="Meeting records",
                    tool_names=["meeting_sessions"],
                )
            ]
        )
        self.assertIn('"category":"one of meeting, general"', prompt)
        self.assertIn("meeting_sessions", prompt)

    def test_general_node_uses_prompt_loader_content(self) -> None:
        provider = DummyProvider()
        state = ChatGraphState(
            provider=provider,
            model="test",
            system_prompt="base prompt",
            messages=[{"role": "user", "content": "hello"}],
            tools=[],
        )

        asyncio.run(handle_general(state.model_dump()))

        self.assertIn("base prompt", provider.system_prompt)
        self.assertIn("This turn is general chat.", provider.system_prompt)

    def test_plugin_domain_node_uses_prompt_loader_content(self) -> None:
        provider = DummyProvider()
        state = ChatGraphState(
            provider=provider,
            model="test",
            system_prompt="base prompt",
            messages=[{"role": "user", "content": "book a room"}],
            tools=[],
            selected_domain="calendar",
            plugin_categories=[
                PluginCategorySpec(
                    id="calendar",
                    name="Calendar",
                    description="Calendar tools",
                    tool_names=["calendar_list"],
                )
            ],
            available_plugin_tools={"calendar": [{"name": "calendar_list"}]},
        )

        asyncio.run(handle_plugin_domain(state.model_dump()))

        self.assertIn("Selected plugin category: Calendar (calendar).", provider.system_prompt)
        self.assertIn("Available tools: calendar_list.", provider.system_prompt)


if __name__ == "__main__":
    unittest.main()
