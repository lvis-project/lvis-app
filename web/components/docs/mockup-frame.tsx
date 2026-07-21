import * as React from "react";
import { cn } from "@/lib/utils";
import { Reveal } from "@/components/motion/reveal";

/**
 * Mac-style window chrome for CSS-mocked UI when no screenshot is available.
 */
export function MockupFrame({
  title,
  children,
  className,
  tone = "white",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  tone?: "white" | "ink";
}) {
  return (
    <Reveal className="my-7">
      <div
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-white shadow-sm",
          tone === "ink" && "bg-ink text-white",
          className
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 border-b border-border px-3 py-2",
            tone === "ink" && "border-white/10"
          )}
        >
          <span className={cn("h-2.5 w-2.5 rounded-full", tone === "ink" ? "bg-white/25" : "bg-ink/15")} />
          <span className={cn("h-2.5 w-2.5 rounded-full", tone === "ink" ? "bg-white/40" : "bg-ink/25")} />
          <span className={cn("h-2.5 w-2.5 rounded-full", tone === "ink" ? "bg-white/60" : "bg-ink/35")} />
          {title ? (
            <span
              className={cn(
                "ml-2 text-[11.5px] font-medium",
                tone === "ink" ? "text-white/70" : "text-muted-foreground"
              )}
            >
              {title}
            </span>
          ) : null}
        </div>
        <div className="p-4">{children}</div>
      </div>
    </Reveal>
  );
}
