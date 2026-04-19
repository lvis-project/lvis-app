import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { BriefingCard } from "./BriefingCard";

const meta: Meta<typeof BriefingCard> = {
  title: "Components/BriefingCard",
  component: BriefingCard,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
  },
  args: {
    onDismiss: fn(),
    onSnooze: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof BriefingCard>;

export const WithItems: Story = {
  args: {
    briefing: {
      generatedAt: new Date().toISOString(),
      summary: "오늘은 미팅 2건과 마감 작업 1건이 있습니다.",
      items: [
        { category: "meeting", priority: "high", title: "주간 팀 회의", detail: "오전 10시" },
        { category: "task", priority: "medium", title: "코드 리뷰 완료", detail: "PR #142" },
        { category: "email", priority: "low", title: "뉴스레터 확인", detail: undefined },
      ],
    },
  },
};

export const EmptyItems: Story = {
  args: {
    briefing: {
      generatedAt: new Date().toISOString(),
      summary: "오늘은 특별한 일정이 없습니다. 좋은 하루 되세요!",
      items: [],
    },
  },
};

export const NoSummary: Story = {
  args: {
    briefing: {
      generatedAt: new Date().toISOString(),
      summary: undefined,
      items: [
        { category: "task", priority: "high", title: "배포 승인 요청", detail: "v2.3.1" },
      ],
    },
  },
};
