import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  title?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error(`[ErrorBoundary] ${this.props.title || "Component"} error:`, error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        <div className="bg-slate-900 border border-yellow-600/40 rounded-lg p-5 shadow-lg space-y-3 font-mono">
          <div className="flex items-center justify-between border-b border-yellow-600/20 pb-2">
            <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></span>
              {this.props.title || "PANEL"} RECOVERY ISOLATION
            </h3>
            <span className="text-[10px] text-yellow-400 bg-yellow-950 px-2 py-0.5 rounded border border-yellow-600/30">
              RECOVERED
            </span>
          </div>
          <div className="text-xs text-slate-400">
            Component execution encountered a runtime layout boundary condition. Isolating DOM tree.
          </div>
          <div className="bg-slate-950 p-2.5 rounded border border-slate-800 text-[11px] text-rose-400 overflow-x-auto">
            {this.state.error?.message || "Render failure intercepted"}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-slate-950 font-bold text-xs rounded uppercase tracking-wider transition"
          >
            RESTART PANEL
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
