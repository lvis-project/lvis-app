import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "storybook/test";
import { AssistantCard } from "./AssistantCard";

const meta: Meta<typeof AssistantCard> = {
  title: "Components/AssistantCard",
  component: AssistantCard,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
};

export default meta;
type Story = StoryObj<typeof AssistantCard>;

export const Default: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: "안녕하세요! 무엇을 도와드릴까요?",
      streaming: false,
    },
    isStarred: false,
    actions: {
      onRetry: fn(),
      onFork: fn(),
      onToggleStar: fn(),
    },
  },
};

export const Streaming: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: "응답을 작성하는 중",
      streaming: true,
    },
  },
};

export const WithMarkdown: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: `## 분석 결과\n\n다음과 같이 정리됩니다:\n\n- **항목 1**: 첫 번째 내용\n- **항목 2**: 두 번째 내용\n\n\`\`\`typescript\nconst result = await analyze();\nconsole.log(result);\n\`\`\``,
      streaming: false,
    },
    actions: {
      onRetry: fn(),
      onFork: fn(),
      onToggleStar: fn(),
    },
  },
};

export const Starred: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: "이 응답은 즐겨찾기에 저장되었습니다.",
      streaming: false,
    },
    isStarred: true,
    actions: {
      onRetry: fn(),
      onFork: fn(),
      onToggleStar: fn(),
    },
  },
};

export const LongResponse: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: "이것은 매우 긴 응답입니다. ".repeat(50),
      streaming: false,
    },
    actions: {
      onRetry: fn(),
      onFork: fn(),
      onToggleStar: fn(),
    },
  },
};
