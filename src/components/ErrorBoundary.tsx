import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Compact tile fallback (defaults to the full-page recovery screen). */
  fallback?: ReactNode;
  /** When this changes, a latched error clears (e.g. garment id). */
  resetKey?: string | number;
}

interface State {
  error: Error | null;
}

/**
 * Error boundary with recovery. The old version replaced the entire app
 * with "Something broke" and no way back — and when the cause was a
 * poisoned persisted snapshot, refresh just looped into the same crash.
 * This one offers Try again plus a Start-fresh escape hatch (clears the
 * local snapshot; cloud data rehydrates on next sign-in).
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    console.error("App crashed:", error, info);
  }

  componentDidUpdate(prevProps: Props) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      // eslint-disable-next-line react/no-did-update-set-state
      this.setState({ error: null });
    }
  }

  private retry = () => {
    this.setState({ error: null });
  };

  private startFresh = () => {
    try {
      localStorage.removeItem("fitflow-store");
    } catch {
      /* ignore */
    }
    window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <p className="font-display text-[20px] font-extrabold">Something didn&rsquo;t load</p>
        <p className="max-w-[300px] text-[13px] font-medium leading-relaxed text-mut">
          {this.state.error.message ||
            "An unexpected error hit this screen. Your closet is safe — this is usually a display hiccup."}
        </p>
        <div className="mt-2 flex gap-2">
          <button
            onClick={this.retry}
            className="rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
          >
            Try again
          </button>
          <button
            onClick={this.startFresh}
            className="rounded-full border border-line px-4 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
          >
            Start fresh
          </button>
        </div>
        <details className="mt-2 max-w-full text-left">
          <summary className="cursor-pointer text-[11px] font-bold text-mut">
            Details
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-mut">
            {this.state.error.stack ?? String(this.state.error)}
          </pre>
        </details>
      </div>
    );
  }
}
