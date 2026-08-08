import type { ReactNode } from "react";
import { vi } from "vitest";
import { ThemeProvider, DEFAULT_BUNDLE_ID } from "../../theme/index.js";

interface McpLvisStubDependencies {
  readUiResource: unknown;
  disposeUiSession: unknown;
  openDetached: unknown;
  closeDetached: unknown;
}

export function stubMcpLvis({
  readUiResource,
  disposeUiSession,
  openDetached,
  closeDetached,
}: McpLvisStubDependencies): void {
  vi.stubGlobal("lvis", {
    mcp: {
      readUiResource,
      disposeUiSession,
      openDetached,
      closeDetached,
      onServerDisconnected: () => () => undefined,
      onDetachedClosed: () => () => undefined,
    },
  });
  (window as unknown as { lvis: unknown }).lvis = (globalThis as unknown as { lvis: unknown }).lvis;
}

/**
 * Wraps a render in the real `ThemeProvider` — `McpAppView` (and the pip panel that
 * hosts it) call `useTheme()`, which throws without a provider. Shared so the
 * MCP-app renderer suites don't each re-declare an identical wrapper.
 */
export function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider initialBundleId={DEFAULT_BUNDLE_ID}>{children}</ThemeProvider>;
}
