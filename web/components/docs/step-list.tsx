import * as React from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";

export interface Step {
  title: string;
  body: React.ReactNode;
  badge?: string;
}

export function StepList({ steps, className }: { steps: Step[]; className?: string }) {
  return (
    <Reveal as="ol" className={cn("my-7 grid gap-3", className)}>
      {steps.map((step, idx) => (
        <li
          key={idx}
          className="grid grid-cols-[44px_1fr] gap-4 rounded-xl border border-border bg-white p-4 transition hover:-translate-y-0.5 hover:shadow-sm"
        >
          <span className="grid h-10 w-10 place-items-center rounded-full bg-secondary text-[13px] font-bold text-ink-soft">
            {String(idx + 1).padStart(2, "0")}
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-[15px] font-semibold text-ink">{step.title}</h4>
              {step.badge ? (
                <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink-soft">
                  {step.badge}
                </span>
              ) : null}
            </div>
            <div className="mt-1.5 text-[14px] leading-relaxed text-muted-foreground [&_p]:my-1.5">
              {step.body}
            </div>
          </div>
        </li>
      ))}
    </Reveal>
  );
}
