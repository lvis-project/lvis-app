/**
 * `onsizechange` handler — the app measured its content (typically via a
 * `ResizeObserver`) and sent `ui/notifications/size-changed` (View → Host). Mirror
 * basic-host: forward the new width/height to the host, which owns the live card
 * dimensions (React state) and clamps them so the card grows with content but does
 * not exceed its container.
 *
 * The `onResize` sink is injected via deps so this module stays React-free and
 * independently unit-testable — McpAppView owns the clamping + state update.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The `onsizechange` notification callback shape, derived from the installed `AppBridge`. */
export type OnSizeChange = NonNullable<AppBridge["onsizechange"]>;

export interface OnSizeChangeDeps {
  /** Apply a content-driven size change to the card (host clamps + applies). */
  onResize(next: { width?: number; height?: number }): void;
}

export function createOnSizeChange({ onResize }: OnSizeChangeDeps): OnSizeChange {
  return ({ width, height }) => {
    onResize({ width, height });
  };
}
