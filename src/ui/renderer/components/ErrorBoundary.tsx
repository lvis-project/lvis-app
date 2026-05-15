import { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "../../../components/ui/button.js";

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
  /**
   * Optional reset hook — when provided, the fallback shows a "다시 시도"
   * button that clears the boundary's error state and re-renders children.
   * For inner boundaries this avoids the deterministic reload-into-same-crash
   * loop where the fault is in the data the boundary's children depend on
   * (e.g. stale plugin manifest still on disk after a reload). Caller can
   * use this hook to ALSO clear the bad state (e.g. force a refresh of
   * plugin cards, switch active view) before the retry happens.
   *
   * Receives the captured `Error` so callers can branch on error class
   * (e.g. "manifest validation failed" → trigger plugin refresh; otherwise
   * → just clear state). The error argument may be undefined if the
   * boundary state was reset programmatically; callers can treat it as
   * optional. onReset throwing is caught — see handleRetry.
   *
   * If `onReset` is omitted, the fallback only offers the full-window
   * reload button (legacy behavior).
   */
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
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground border-b border-warning bg-warning/10">
            <span>{this.props.fallback ?? "이 영역에 오류가 발생했습니다"}</span>
            {showRetry && (
              <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={this.handleRetry}>다시 시도</Button>
            )}
            <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>새로고침</Button>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">{this.props.fallback ?? "렌더링 오류"}</p>
          <div className="flex items-center gap-3">
            {showRetry && (
              <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={this.handleRetry}>다시 시도</Button>
            )}
            <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>새로고침</Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
