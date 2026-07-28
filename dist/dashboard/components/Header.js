"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Header = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const store_1 = require("../store");
const useTelemetryRefMutator_1 = require("../hooks/useTelemetryRefMutator");
const Header = () => {
    const connectionStatus = (0, store_1.useTelemetrySelector)((state) => state.connectionStatus);
    const isEngineActive = (0, store_1.useTelemetrySelector)((state) => state.isEngineActive);
    const isConnected = connectionStatus === "CONNECTED";
    const sequenceNumRef = (0, react_1.useRef)(null);
    const tickLatencyRef = (0, react_1.useRef)(null);
    const rttMsRef = (0, react_1.useRef)(null);
    // Bind direct RAF DOM mutator for zero React VDOM re-renders
    (0, useTelemetryRefMutator_1.useTelemetryRefMutator)({
        sequenceNumRef,
        tickLatencyRef,
        rttMsRef,
    });
    return ((0, jsx_runtime_1.jsxs)("header", { className: "bg-slate-900 border-b border-yellow-600/30 px-6 py-3.5 flex flex-wrap items-center justify-between shadow-lg", children: [(0, jsx_runtime_1.jsx)("div", { className: "flex items-center space-x-4", children: (0, jsx_runtime_1.jsxs)("h1", { className: "text-xl font-extrabold tracking-wide text-yellow-500 uppercase flex items-center gap-2", children: [(0, jsx_runtime_1.jsx)("span", { className: "w-3 h-3 rounded-full bg-yellow-500 animate-pulse" }), "BATBOT_V11 ", (0, jsx_runtime_1.jsx)("span", { className: "text-slate-400 font-medium text-sm", children: "HFT TELEMETRY & CONTROL DASHBOARD" })] }) }), (0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-6 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-400 font-semibold", children: "STREAM:" }), (0, jsx_runtime_1.jsx)("span", { className: `px-2 py-0.5 rounded font-bold ${isConnected ? "bg-emerald-950 text-emerald-400 border border-emerald-600" : "bg-rose-950 text-rose-400 border border-rose-600"}`, children: connectionStatus })] }), (0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-400 font-semibold", children: "ENGINE:" }), (0, jsx_runtime_1.jsx)("span", { className: `px-2 py-0.5 rounded font-bold ${isEngineActive ? "bg-yellow-950 text-yellow-400 border border-yellow-500" : "bg-slate-800 text-slate-400"}`, children: isEngineActive ? "LIVE ACTIVE" : "IDLE / PAUSED" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "hidden lg:flex items-center space-x-4 border-l border-slate-800 pl-4 text-slate-300", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-500", children: "SEQ:" }), " ", (0, jsx_runtime_1.jsx)("span", { ref: sequenceNumRef, className: "text-yellow-400 font-semibold", children: "#0" })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-500", children: "LATENCY:" }), " ", (0, jsx_runtime_1.jsx)("span", { ref: tickLatencyRef, className: "text-yellow-400 font-semibold", children: "0.00 \u00B5s" })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-500", children: "RTT:" }), " ", (0, jsx_runtime_1.jsx)("span", { ref: rttMsRef, className: "text-yellow-400 font-semibold", children: "0.0 ms" })] })] })] })] }));
};
exports.Header = Header;
