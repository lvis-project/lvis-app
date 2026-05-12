import type { CSSProperties } from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { AssistantCard } from "../components/AssistantCard";
import { BUNDLES, type ThemeBundle } from "./bundles/index";

const markdownSample = `**서울 기준** 다음 7일(5/12-5/18) **예보에요. (최고/최저, 강수확률은 대략)**

| 날짜 | 날씨 | 최고/최저 | 강수 |
| --- | --- | --- | --- |
| 5/12(화) | 구름 조금 | 24° / 13° | 1% |
| 5/13(수) | 맑음+부분구름 | 25° / 12° | 1% |
| 5/14(목) | 대체로 맑음 | 30° / 16° | 1% |

- 근거: **AccuWeather 10-day** 예보(서울)

\`\`\`ts
const readable = theme.foreground !== theme.background;
console.log({ readable });
\`\`\``;

const sampleEntry = {
  kind: "assistant",
  text: markdownSample,
  streaming: false,
} as const;

function bundleStyle(bundle: ThemeBundle): CSSProperties {
  const style = {
    colorScheme: bundle.shell,
  } as CSSProperties & Record<`--${string}`, string>;

  for (const [key, value] of Object.entries(bundle.tokens)) {
    style[`--${key}`] = value;
  }

  return style;
}

function ThemeBundleGallery() {
  return (
    <div className="min-h-screen bg-background p-4 text-foreground">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {BUNDLES.map((bundle) => (
          <section
            key={bundle.id}
            data-theme-bundle={bundle.id}
            data-shell={bundle.shell}
            style={bundleStyle(bundle)}
            className="min-w-0 rounded-md border border-border bg-background p-3 text-foreground"
          >
            <div className="mb-3 flex min-w-0 items-center justify-between gap-3 border-b border-border pb-2">
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">{bundle.name}</h2>
                <p className="truncate text-xs text-muted-foreground">{bundle.id}</p>
              </div>
              <span className="shrink-0 rounded border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {bundle.shell}
              </span>
            </div>
            <AssistantCard entry={sampleEntry} />
          </section>
        ))}
      </div>
    </div>
  );
}

const meta: Meta<typeof ThemeBundleGallery> = {
  title: "Theme/All Bundles",
  component: ThemeBundleGallery,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
    controls: { disable: true },
  },
};

export default meta;
type Story = StoryObj<typeof ThemeBundleGallery>;

export const MarkdownAndTables: Story = {};
