import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Reveal } from "@/components/motion/reveal";

export function PageHero({
  eyebrow,
  title,
  description,
  tags,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  tags?: string[];
}) {
  return (
    <Reveal as="header" className="mb-10 border-b border-border pb-8">
      {eyebrow ? (
        <p className="mb-3 inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1 text-[10.5px] font-bold uppercase tracking-[0.16em] text-ink-soft">
          <span className="h-1 w-1 rounded-full bg-ink" />
          {eyebrow}
        </p>
      ) : null}
      <h1 className="text-[clamp(2rem,4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.025em] text-ink">
        {title}
      </h1>
      {description ? (
        <p className="mt-4 max-w-3xl text-[16.5px] leading-relaxed text-muted-foreground">
          {description}
        </p>
      ) : null}
      {tags?.length ? (
        <div className="mt-5 flex flex-wrap gap-1.5">
          {tags.map((t) => (
            <Badge key={t} variant="muted">
              {t}
            </Badge>
          ))}
        </div>
      ) : null}
    </Reveal>
  );
}
