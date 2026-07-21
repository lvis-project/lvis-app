import * as React from "react";
import { Info, AlertTriangle, Sparkles, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutTone = "info" | "warn" | "tip" | "security";

// Mostly monochrome; amber is the one reserved semantic signal for warnings (see DESIGN.md §7).
const config: Record<CalloutTone, { bg: string; border: string; text: string; Icon: React.ComponentType<{ className?: string }> }> = {
  info:     { bg: "bg-secondary/60", border: "border-border",      text: "text-ink-soft",   Icon: Info },
  warn:     { bg: "bg-amber-50",     border: "border-amber-200",   text: "text-amber-700",  Icon: AlertTriangle },
  tip:      { bg: "bg-accent/70",    border: "border-glow/40",     text: "text-ink",        Icon: Sparkles },
  security: { bg: "bg-ink/[0.04]",   border: "border-ink/20",      text: "text-ink",        Icon: ShieldCheck },
};

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: CalloutTone;
  title?: string;
  children: React.ReactNode;
}) {
  const c = config[tone];
  const Icon = c.Icon;
  return (
    <div className={cn("my-5 rounded-lg border p-4", c.bg, c.border)}>
      <div className={cn("flex items-center gap-2 text-[13px] font-semibold", c.text)}>
        <Icon className="h-4 w-4" />
        <span>{title ?? tone.toUpperCase()}</span>
      </div>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-ink-soft [&_p]:my-1.5 [&_code]:rounded [&_code]:bg-white [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px]">
        {children}
      </div>
    </div>
  );
}
