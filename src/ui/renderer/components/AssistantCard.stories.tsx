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
      text: "Hello. What can I help with?",
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
      text: "Writing a response",
      streaming: true,
    },
  },
};

export const WithMarkdown: Story = {
  args: {
    entry: {
      kind: "assistant",
      text: `## Analysis Result\n\nThe result is organized as follows:\n\n- **Item 1**: First detail\n- **Item 2**: Second detail\n\n\`\`\`typescript\nconst result = await analyze();\nconsole.log(result);\n\`\`\``,
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
      text: "This response was saved to insights.",
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
      text: "This is a very long response. ".repeat(50),
      streaming: false,
    },
    actions: {
      onRetry: fn(),
      onFork: fn(),
      onToggleStar: fn(),
    },
  },
};
