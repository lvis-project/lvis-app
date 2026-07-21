import * as React from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";

export interface Feature {
  icon?: React.ReactNode;
  title: string;
  body: React.ReactNode;
  tone?: "teal" | "citron" | "coral" | "ink";
}

// Tones are now quiet neutral tints — no brand color (see DESIGN.md §7).
const toneClass: Record<NonNullable<Feature["tone"]>, string> = {
  teal: "border-border bg-secondary/40",
  citron: "border-glow/40 bg-accent/60",
  coral: "border-border bg-secondary/40",
  ink: "border-border bg-secondary",
};

export function FeatureGrid({
  items,
  columns = 3,
  className,
}: {
  items: Feature[];
  columns?: 2 | 3 | 4;
  className?: string;
}) {
  return (
    <Reveal
      className={cn(
        "my-7 grid gap-3",
        columns === 2 && "grid-cols-1 sm:grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        columns === 4 && "grid-cols-2 lg:grid-cols-4",
        className
      )}
    >
      {items.map((f, i) => (
        <div
          key={i}
          className={cn(
            "rounded-xl border p-4 transition hover:-translate-y-0.5 hover:shadow-sm",
            f.tone ? toneClass[f.tone] : "border-border bg-white"
          )}
        >
          {f.icon ? (
            <span className="icon-chip mb-3 inline-grid h-9 w-9">{f.icon}</span>
          ) : null}
          <h4 className="text-[14.5px] font-semibold text-ink">{f.title}</h4>
          <div className="mt-1 text-[13.5px] leading-relaxed text-muted-foreground">
            {f.body}
          </div>
        </div>
      ))}
    </Reveal>
  );
}
