import type { Meta, StoryObj } from "@storybook/react";
import { Sparkline } from "./Sparkline";

const meta: Meta<typeof Sparkline> = {
  title: "Components/Sparkline",
  component: Sparkline,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof Sparkline>;

export const Default: Story = {
  args: {
    points: [10, 30, 20, 50, 40, 60, 45, 70],
  },
};

export const SinglePoint: Story = {
  args: {
    points: [42],
  },
};

export const Empty: Story = {
  args: {
    points: [],
  },
};

export const Rising: Story = {
  args: {
    points: [5, 15, 25, 35, 50, 65, 80, 100],
    width: 320,
    height: 60,
  },
};

export const Volatile: Story = {
  args: {
    points: [80, 10, 90, 5, 70, 15, 95, 20],
    width: 200,
    height: 40,
  },
};
