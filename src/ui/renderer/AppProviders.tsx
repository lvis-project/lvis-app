import type { ReactNode, RefObject } from "react";
import { useTranslation } from "../../i18n/react.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ThemeProvider } from "./theme/index.js";
import {
  OverlayContextProvider,
  type OverlayContextValue,
} from "./context/OverlayContext.js";
import type { getApi } from "./api-client.js";

type Api = ReturnType<typeof getApi>;

/**
 * AppProviders — the composition root's provider stack.
 *
 * Wraps the whole renderer tree in (outer → inner):
 *   ErrorBoundary → ThemeProvider → TooltipProvider → OverlayContextProvider
 *
 * IMPORTANT (render-order coupling): OverlayContextProvider MUST stay INSIDE
 * this stack. It populates `addFireRef.current` DURING ITS RENDER (a synchronous
 * assignment, before any effects fire), so the routine/overlay IPC subscriptions
 * that App owns can call addFire() from outside the React tree. Hoisting it out
 * — or mounting it below its consumers — would leave that ref null when the
 * first IPC event lands. See src/ui/renderer/context/OverlayContext.tsx.
 */
export function AppProviders({
  api,
  onOpenSession,
  addFireRef,
  runningRoutines,
  children,
}: {
  api: Api;
  onOpenSession: (sessionId: string) => boolean | Promise<boolean>;
  addFireRef: RefObject<OverlayContextValue["addFire"] | null>;
  runningRoutines: Set<string>;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <ErrorBoundary fallback={t("app.appErrorFallback")}>
      <ThemeProvider api={api}>
        <TooltipProvider>
          <OverlayContextProvider
            onOpenSession={onOpenSession}
            addFireRef={addFireRef}
            runningRoutines={runningRoutines}
          >
            {children}
          </OverlayContextProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
