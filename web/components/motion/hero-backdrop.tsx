import { cn } from "@/lib/utils";

/**
 * Quiet hero backdrop — one static periwinkle glow over a faint grid.
 * v3 "Quiet unification": no drifting/panning animation (see DESIGN.md).
 */
export function HeroBackdrop({ className }: { className?: string }) {
  return (
    <div className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)} aria-hidden>
      <div className="hero-grid absolute inset-0 opacity-40" />
      <div
        className="hero-glow right-[8%] top-[-10%] h-[420px] w-[420px]"
        style={{ background: "radial-gradient(circle, rgba(183,191,217,0.35), transparent 70%)" }}
      />
      {/* soft top fade so the header reads cleanly */}
      <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background to-transparent" />
    </div>
  );
}
