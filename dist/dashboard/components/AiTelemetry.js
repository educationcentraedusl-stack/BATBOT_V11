"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiTelemetry = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const uplot_1 = __importDefault(require("uplot"));
const store_1 = require("../store");
const useTelemetryRefMutator_1 = require("../hooks/useTelemetryRefMutator");
const AiTelemetry = () => {
    const chartRef = (0, react_1.useRef)(null);
    const uplotInstance = (0, react_1.useRef)(null);
    const rafIdRef = (0, react_1.useRef)(null);
    // Direct DOM Mutator Refs for 0-VDOM Render Metric Updating
    const directionRef = (0, react_1.useRef)(null);
    const directionBadgeRef = (0, react_1.useRef)(null);
    const confidenceRef = (0, react_1.useRef)(null);
    const infLatUsRef = (0, react_1.useRef)(null);
    const gate1Ref = (0, react_1.useRef)(null);
    const gate2Ref = (0, react_1.useRef)(null);
    const gate3Ref = (0, react_1.useRef)(null);
    const gate4Ref = (0, react_1.useRef)(null);
    (0, useTelemetryRefMutator_1.useTelemetryRefMutator)({
        directionRef,
        directionBadgeRef,
        confidenceRef,
        infLatUsRef,
        gate1Ref,
        gate2Ref,
        gate3Ref,
        gate4Ref,
    });
    // Initialize ResizeObserver & Direct RAF Canvas Engine for zero React re-render chart rendering
    (0, react_1.useEffect)(() => {
        const container = chartRef.current;
        if (!container)
            return;
        let isSubscribed = true;
        const history = (0, store_1.getHistorySnapshot)();
        const initOrResizeChart = (width, height) => {
            if (width <= 0 || height <= 0 || !isSubscribed)
                return;
            if (!uplotInstance.current) {
                container.innerHTML = "";
                const opts = {
                    title: "CfC ||h_t|| HIDDEN STATE NORM DRIFT",
                    width,
                    height,
                    series: [
                        {},
                        {
                            label: "Norm",
                            stroke: "#eab308", // Dark Yellow Canvas plot line
                            width: 2,
                        },
                    ],
                    axes: [
                        { show: false },
                        {
                            stroke: "#94a3b8",
                            size: 35,
                            font: "10px monospace",
                            grid: { stroke: "#1e293b", width: 1 },
                        },
                    ],
                };
                const count = history.count > 0 ? history.count : 1;
                const initialTs = history.count > 0 ? history.timestamps.subarray(0, count) : new Float64Array([Date.now() / 1000]);
                const initialNorms = history.count > 0 ? history.stateNorms.subarray(0, count) : new Float64Array([0]);
                try {
                    uplotInstance.current = new uplot_1.default(opts, [initialTs, initialNorms], container);
                }
                catch {
                    // Prevent crash on zero dimensions or invalid DOM state
                }
            }
            else {
                uplotInstance.current.setSize({ width, height });
            }
        };
        // Defensive ResizeObserver to prevent zero-dimension instantiation crashes
        const ro = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                if (width > 0 && height > 0) {
                    initOrResizeChart(Math.floor(width), Math.floor(height || 140));
                }
            }
        });
        ro.observe(container);
        // Off-Main-Thread Direct RAF Canvas Update Loop (Bypasses React VDOM entirely)
        let lastRenderedCount = -1;
        const renderLoop = () => {
            if (!isSubscribed)
                return;
            if (uplotInstance.current && history.count > 0 && history.count !== lastRenderedCount) {
                lastRenderedCount = history.count;
                const tsSlice = history.timestamps.subarray(0, history.count);
                const normSlice = history.stateNorms.subarray(0, history.count);
                uplotInstance.current.setData([tsSlice, normSlice]);
            }
            rafIdRef.current = requestAnimationFrame(renderLoop);
        };
        rafIdRef.current = requestAnimationFrame(renderLoop);
        return () => {
            isSubscribed = false;
            ro.disconnect();
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
            if (uplotInstance.current) {
                uplotInstance.current.destroy();
                uplotInstance.current = null;
            }
        };
    }, []);
    return ((0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5", children: [(0, jsx_runtime_1.jsxs)("div", { className: "border-b border-yellow-600/30 pb-3 flex items-center justify-between", children: [(0, jsx_runtime_1.jsxs)("h2", { className: "text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2", children: [(0, jsx_runtime_1.jsx)("svg", { className: "w-5 h-5 text-yellow-500", fill: "none", stroke: "currentColor", viewBox: "0 0 24 24", children: (0, jsx_runtime_1.jsx)("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d: "M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" }) }), "AI TELEMETRY & SHADOW INSPECTOR"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-xs text-yellow-400 font-mono", children: "T-KAN + CfC CELL" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "grid grid-cols-2 gap-4 bg-slate-950 p-4 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "text-xs text-slate-400 font-semibold mb-1", children: "PREDICTED DIRECTION" }), (0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { ref: directionRef, className: "text-xl font-black text-slate-400", children: "+0.0000" }), (0, jsx_runtime_1.jsx)("span", { ref: directionBadgeRef, className: "text-xs px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-400", children: "NEUTRAL" })] })] }), (0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { className: "text-xs text-slate-400 font-semibold mb-1", children: "NEURAL CONFIDENCE" }), (0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { ref: confidenceRef, className: "text-xl font-black text-yellow-400", children: "0.0%" }), (0, jsx_runtime_1.jsx)("span", { ref: infLatUsRef, className: "text-xs text-slate-400 font-mono", children: "(0.0 \u00B5s)" })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "space-y-2", children: [(0, jsx_runtime_1.jsx)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider", children: "GATE 1\u20134 PRE-FLIGHT VALIDATION RADAR" }), (0, jsx_runtime_1.jsxs)("div", { className: "grid grid-cols-2 gap-2 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-300", children: "GATE 1 (SPEARMAN IC > 0.03):" }), (0, jsx_runtime_1.jsx)("span", { ref: gate1Ref, className: "font-bold text-slate-500", children: "0.0000 [STANDBY]" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-300", children: "GATE 2 (LATENCY PENALTY):" }), (0, jsx_runtime_1.jsx)("span", { ref: gate2Ref, className: "font-bold text-slate-500", children: "0.00x [STANDBY]" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-300", children: "GATE 3 (RISK COLLAR / VaR):" }), (0, jsx_runtime_1.jsx)("span", { ref: gate3Ref, className: "font-bold text-slate-500", children: "0.00% / - [STANDBY]" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center", children: [(0, jsx_runtime_1.jsx)("span", { className: "text-slate-300", children: "GATE 4 (SLIPPAGE BUFFER):" }), (0, jsx_runtime_1.jsx)("span", { ref: gate4Ref, className: "font-bold text-slate-500", children: "0 TICKS [STANDBY]" })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsx)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider", children: "CfC RECURRENT CELL STATE NORM (CANVAS 2D)" }), (0, jsx_runtime_1.jsx)("div", { ref: chartRef, className: "w-full h-36 min-h-[140px] flex items-center justify-center" })] })] }));
};
exports.AiTelemetry = AiTelemetry;
