import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props { children: ReactNode; fallback?: string }
interface State { hasError: boolean; error?: Error }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };
  static getDerivedStateFromError(error: Error): State { return { hasError: true, error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[lvis] render error:", error, info); }
  render() {
    if (this.state.hasError) return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-8 text-center">
        <p className="text-sm text-muted-foreground">{this.props.fallback ?? "렌더링 오류"}</p>
        <button className="text-xs underline" onClick={() => window.location.reload()}>새로고침</button>
      </div>
    );
    return this.props.children;
  }
}
