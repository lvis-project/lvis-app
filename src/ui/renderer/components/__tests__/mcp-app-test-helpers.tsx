import type { ReactNode } from "react";
import { ThemeProvider, DEFAULT_BUNDLE_ID } from "../../theme/index.js";

/**
 * Wraps a render in the real `ThemeProvider` — `McpAppView` (and the pip panel that
 * hosts it) call `useTheme()`, which throws without a provider. Shared so the
 * MCP-app renderer suites don't each re-declare an identical wrapper.
 */
export function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider initialBundleId={DEFAULT_BUNDLE_ID}>{children}</ThemeProvider>;
}
