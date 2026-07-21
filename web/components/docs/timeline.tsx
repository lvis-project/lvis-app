import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";
import type { VersionPlan, Status } from "@/lib/roadmap";

// Monochrome-tonal status system — rank by fill weight, not hue.
const statusLabel: Record<Status, { label: string; labelEn: string; cls: string }> = {
  shipping: { label: "Shipping", labelEn: "Shipping", cls: "bg-ink text-white" },
  "in-progress": { label: "진행 중", labelEn: "In progress", cls: "bg-accent text-ink" },
  planned: { label: "예정", labelEn: "Planned", cls: "bg-secondary text-ink" },
  exploring: {
    label: "탐색",
    labelEn: "Exploring",
    cls: "border border-border bg-white text-muted-foreground",
  },
};

const vibeCls: Record<VersionPlan["vibe"], string> = {
  foundation: "from-secondary/70 via-secondary/20 to-transparent border-border",
  autonomous: "from-accent/60 via-accent/20 to-transparent border-glow/40",
  open: "from-secondary/50 via-secondary/10 to-transparent border-border",
  frontier: "from-ink/[0.06] via-ink/[0.02] to-transparent border-ink/20",
};

export function RoadmapTimeline({
  versions,
  locale = "ko",
}: {
  versions: VersionPlan[];
  locale?: "ko" | "en";
}) {
  const isEn = locale === "en";
  return (
    <Reveal as="ol" className="my-8 grid gap-4">
      {versions.map((v) => (
        <li
          key={v.version}
          className={cn(
            "relative overflow-hidden rounded-xl border bg-gradient-to-br p-6",
            vibeCls[v.vibe]
          )}
        >
          <div className="mb-5 flex items-baseline gap-3">
            <span className="inline-grid h-9 min-w-[36px] place-items-center rounded-full bg-white px-2 font-mono text-[13px] font-bold text-ink shadow-sm">
              {v.version}
            </span>
            <h3 className="text-[18px] font-semibold leading-tight tracking-tight text-ink">
              {isEn ? (v.themeEn ?? v.theme) : v.theme}
            </h3>
          </div>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {v.milestones.map((m) => {
              const s = statusLabel[m.status];
              return (
                <li
                  key={m.title}
                  className="rounded-lg border border-border bg-white/90 p-4 backdrop-blur"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-[14.5px] font-semibold text-ink">
                      {isEn ? (m.titleEn ?? m.title) : m.title}
                    </p>
                    <span
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10.5px] font-bold uppercase tracking-wider",
                        s.cls
                      )}
                    >
                      {isEn ? s.labelEn : s.label}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                    {isEn ? (m.detailEn ?? m.detail) : m.detail}
                  </p>
                  {m.diagramAnchor ? (
                    <Link
                      href={`/docs/architecture/diagrams#${m.diagramAnchor}`}
                      className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-ink hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {isEn ? "View related diagram" : "관련 다이어그램 보기"}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </Reveal>
  );
}

const axisAccent: Record<string, string> = {
  teal: "border-border bg-secondary/50",
  coral: "border-border bg-secondary/40",
  citron: "border-glow/40 bg-accent/50",
  ink: "border-ink/20 bg-secondary",
};

export function AxisCards({
  axes,
  locale = "ko",
}: {
  axes: ReadonlyArray<{
    id: string;
    title: string;
    titleEn?: string;
    summary: string;
    summaryEn?: string;
    accent: string;
  }>;
  locale?: "ko" | "en";
}) {
  const isEn = locale === "en";
  return (
    <Reveal className="my-6 grid gap-3 sm:grid-cols-2">
      {axes.map((a) => (
        <article
          key={a.id}
          id={`axis-${a.id}`}
          className={cn(
            "rounded-lg border bg-white p-5 transition hover:shadow-sm",
            axisAccent[a.accent] ?? "border-border"
          )}
        >
          <h3 className="text-[16.5px] font-semibold text-ink">
            {isEn ? (a.titleEn ?? a.title) : a.title}
          </h3>
          <p className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">
            {isEn ? (a.summaryEn ?? a.summary) : a.summary}
          </p>
        </article>
      ))}
    </Reveal>
  );
}
