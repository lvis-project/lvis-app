/**
 * `onsizechange` handler — the app measured its content (typically via a
 * `ResizeObserver`) and sent `ui/notifications/size-changed` (View → Host). Mirror
 * basic-host: forward the reported width/height to the host.
 *
 * The numbers are UNTRUSTED and are NOT bounded here. They are bounded at the sink,
 * where they become pixels: McpAppView's `onResize` runs them through
 * `clampMcpAppCardSize` (shared/mcp-app-card-size.ts), which rejects non-finite / ≤ 0
 * values and clamps the rest into `MCP_APP_CARD_{MIN,MAX}_{WIDTH,HEIGHT}_PX`. One
 * bound, at one sink — this module stays a pure forward so it remains React-free and
 * independently unit-testable.
 */
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";

/** The `onsizechange` notification callback shape, derived from the installed `AppBridge`. */
export type OnSizeChange = NonNullable<AppBridge["onsizechange"]>;

export interface OnSizeChangeDeps {
  /**
   * Apply a content-driven size change to the card. The sink is where the bound lives:
   * it clamps the reported numbers into the card-size SoT before they reach layout.
   */
  onResize(next: { width?: number; height?: number }): void;
}

export function createOnSizeChange({ onResize }: OnSizeChangeDeps): OnSizeChange {
  return ({ width, height }) => {
    onResize({ width, height });
  };
}
