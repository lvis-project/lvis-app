import type { CSSProperties } from "react";
import { useEdgeResize, type UseEdgeResizeOptions } from "../hooks/use-edge-resize.js";

export interface EdgeResizeBarProps extends UseEdgeResizeOptions {
  ariaLabel: string;
  /** Width reset target for double-click / Enter. */
  resetWidth: number;
  "data-testid"?: string;
  /**
   * `"straddle"` (default) centers the 8px hit strip ON the panel boundary
   * (half outside) — use when the panel's container does NOT clip overflow.
   * `"inset"` keeps the whole hit strip inside the panel edge — use when the
   * container is `overflow-hidden` (a straddled strip would be half-clipped).
   */
  variant?: "straddle" | "inset";
  /** Passthrough style — e.g. Electron's WebkitAppRegion: "no-drag" when the
   * bar overlays a window drag band. */
  style?: CSSProperties;
}

/**
 * Shared drag-to-resize edge bar — ONE visual + interaction + a11y code path
 * for every panel that resizes along a vertical edge (the left Sidebar's
 * right edge, the right-docked ChatSidePanel's left edge). Renders a
 * full-height 8px hit strip with a thin 2px visible rule that tints on
 * hover/focus, positioned at the panel's resize edge (`edge="end"` → bar sits
 * at the panel's right; `edge="start"` → bar sits at the panel's left). All
 * drag/keyboard/reset logic is delegated to `useEdgeResize`; this component
 * only draws the bar and wires its DOM events to that hook.
 *
 * a11y: `role="separator"` + `aria-orientation="vertical"` + arrow-key steps
 * (direction always matches the visual edge) + Home/End to the bounds +
 * double-click or Enter to reset to `resetWidth`.
 */
export function EdgeResizeBar({
  width,
  edge,
  onWidthChange,
  onWidthCommit,
  min,
  max,
  keyStep,
  applyElementRef,
  ariaLabel,
  resetWidth,
  "data-testid": testId,
  variant = "straddle",
  style,
}: EdgeResizeBarProps) {
  const { onPointerDown, onKeyDown, makeResetHandler, resolveMax } = useEdgeResize({
    width,
    edge,
    onWidthChange,
    onWidthCommit,
    min,
    max,
    keyStep,
    applyElementRef,
  });

  const straddle = variant === "straddle";
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={Math.round(resolveMax())}
      tabIndex={0}
      data-testid={testId}
      className={[
        "group absolute inset-y-0 z-40 flex w-2 cursor-col-resize touch-none select-none items-center outline-none",
        edge === "end"
          ? `right-0 justify-end ${straddle ? "translate-x-1/2" : ""}`
          : `left-0 justify-start ${straddle ? "-translate-x-1/2" : ""}`,
      ].join(" ")}
      style={style}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={makeResetHandler(resetWidth)}
    >
      <span className="h-full w-0.5 rounded-full bg-transparent transition-colors group-hover:bg-primary group-focus-visible:bg-primary" />
    </div>
  );
}
