// RoutineRunningIndicator — shows a spinning indicator while one or more
// routine LLM sessions are in-flight. Renders null when idle.

interface RoutineRunningIndicatorProps {
  routines: Set<string>;
}

export function RoutineRunningIndicator({ routines }: RoutineRunningIndicatorProps) {
  if (routines.size === 0) return null;

  return (
    <div
      data-testid="routine-running-indicator"
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute bottom-2 right-4 z-20 flex items-center gap-1.5 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-xs text-violet-400"
    >
      <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-violet-400 border-t-transparent" />
      진행 중인 루틴 {routines.size}개
    </div>
  );
}
