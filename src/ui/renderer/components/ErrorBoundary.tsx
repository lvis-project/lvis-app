import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "../../../components/ui/button.js";
import { t } from "../../../i18n/runtime.js";

interface Props {
  children: ReactNode;
  /** Headline shown when the boundary triggers. */
  fallback?: string;
  /**
   * Identifier for the boundary's scope (e.g. "main-content", "plugin-grid").
   * Logged with the error so multi-boundary apps can distinguish which
   * region failed without rebuilding the React tree. Issue #736: when a
   * single stale plugin manifest crashes the renderer, this lets us see
   * WHICH boundary caught it.
   */
  boundaryName?: string;
  /**
   * Optional inline mode — when true, renders a compact one-line fallback
   * suitable for embedding inside a larger UI (badges, status bars).
   * Default is the full centered card.
   */
  compact?: boolean;



  onReset?: (error: Error | undefined) => void;
}
interface State { hasError: boolean; error: Error | undefined }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: undefined };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const scope = this.props.boundaryName ?? "<root>";
    console.error(`[lvis] render error in boundary='${scope}':`, error, info);
  }
  private handleRetry = () => {
    const capturedError = this.state.error;
    try {
      this.props.onReset?.(capturedError);
    } catch (err) {
      // Caller's onReset throwing must not stick the boundary in error
      // state. Log + continue to setState so children get re-rendered. If
      // the children still throw, the boundary catches again — no infinite
      // loop because React's getDerivedStateFromError fires once per
      // render cycle, not in a tight retry loop.
      console.error(`[lvis] onReset hook threw in boundary='${this.props.boundaryName ?? "<root>"}':`, err);
    }
    this.setState({ hasError: false, error: undefined });
  };
  render() {
    if (this.state.hasError) {
      const showRetry = typeof this.props.onReset === "function";
      if (this.props.compact) {
        return (
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground border-b border-warning bg-warning/(--opacity-subtle)">
            <span>{this.props.fallback ?? t("errorBoundary.compactFallback")}</span>
            {showRetry && (
              <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={this.handleRetry}>{t("errorBoundary.retryButton")}</Button>
            )}
            <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>{t("errorBoundary.reloadButton")}</Button>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">{this.props.fallback ?? t("errorBoundary.fullFallback")}</p>
          <div className="flex items-center gap-3">
            {showRetry && (
              <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={this.handleRetry}>{t("errorBoundary.retryButton")}</Button>
            )}
            <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>{t("errorBoundary.reloadButton")}</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
