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
}
interface State { hasError: boolean; message: string }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: "" };
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, message: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const scope = this.props.boundaryName ?? "<root>";
    console.error(`[lvis] render error in boundary='${scope}':`, error, info);
  }
  render() {
    if (this.state.hasError) {
      if (this.props.compact) {
        return (
          <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted-foreground border-b border-warning bg-warning/10">
            <span>{this.props.fallback ?? "이 영역에 오류가 발생했습니다"}</span>
            <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>새로고침</Button>
          </div>
        );
      }
      return (
        <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
          <p className="text-sm text-muted-foreground">{this.props.fallback ?? "렌더링 오류"}</p>
          <Button variant="link" size="sm" className="text-xs h-auto p-0" onClick={() => window.location.reload()}>새로고침</Button>
        </div>
      );
    }
    return this.props.children;
  }
}
