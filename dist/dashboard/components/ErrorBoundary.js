"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErrorBoundary = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
class ErrorBoundary extends react_1.Component {
    state = {
        hasError: false,
        error: null,
    };
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        console.error(`[ErrorBoundary] ${this.props.title || "Component"} error:`, error, errorInfo);
    }
    render() {
        if (this.state.hasError) {
            return ((0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-900 border border-yellow-600/40 rounded-lg p-5 shadow-lg space-y-3 font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex items-center justify-between border-b border-yellow-600/20 pb-2", children: [(0, jsx_runtime_1.jsxs)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2", children: [(0, jsx_runtime_1.jsx)("span", { className: "w-2 h-2 rounded-full bg-yellow-500 animate-pulse" }), this.props.title || "PANEL", " RECOVERY ISOLATION"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-[10px] text-yellow-400 bg-yellow-950 px-2 py-0.5 rounded border border-yellow-600/30", children: "RECOVERED" })] }), (0, jsx_runtime_1.jsx)("div", { className: "text-xs text-slate-400", children: "Component execution encountered a runtime layout boundary condition. Isolating DOM tree." }), (0, jsx_runtime_1.jsx)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800 text-[11px] text-rose-400 overflow-x-auto", children: this.state.error?.message || "Render failure intercepted" }), (0, jsx_runtime_1.jsx)("button", { onClick: () => this.setState({ hasError: false, error: null }), className: "px-3 py-1.5 bg-yellow-600 hover:bg-yellow-500 text-slate-950 font-bold text-xs rounded uppercase tracking-wider transition", children: "RESTART PANEL" })] }));
        }
        return this.props.children;
    }
}
exports.ErrorBoundary = ErrorBoundary;
