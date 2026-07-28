"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ExecutionView = void 0;
const jsx_runtime_1 = require("react/jsx-runtime");
const react_1 = require("react");
const uplot_1 = __importDefault(require("uplot"));
const react_virtuoso_1 = require("react-virtuoso");
const store_1 = require("../store");
const useTelemetryRefMutator_1 = require("../hooks/useTelemetryRefMutator");
const ExecutionView = () => {
    // ONLY subscribe to executions array (re-renders ONLY on actual trade execution events)
    const executions = (0, store_1.useTelemetrySelector)((state) => state.executions);
    const chartRef = (0, react_1.useRef)(null);
    const uplotInstance = (0, react_1.useRef)(null);
    const rafIdRef = (0, react_1.useRef)(null);
    // Direct DOM Mutator Refs for high-frequency inventory & microstructure metrics
    const realizedPnlRef = (0, react_1.useRef)(null);
    const unrealizedPnlRef = (0, react_1.useRef)(null);
    const winRateRef = (0, react_1.useRef)(null);
    const totalTradesRef = (0, react_1.useRef)(null);
    const obiValRef = (0, react_1.useRef)(null);
    const obiBarGreenRef = (0, react_1.useRef)(null);
    const obiBarRedRef = (0, react_1.useRef)(null);
    const cvdValRef = (0, react_1.useRef)(null);
    const bidPriceRef = (0, react_1.useRef)(null);
    const askPriceRef = (0, react_1.useRef)(null);
    (0, useTelemetryRefMutator_1.useTelemetryRefMutator)({
        realizedPnlRef,
        unrealizedPnlRef,
        winRateRef,
        totalTradesRef,
        obiValRef,
        obiBarGreenRef,
        obiBarRedRef,
        cvdValRef,
        bidPriceRef,
        askPriceRef,
    });
    // Initialize ResizeObserver & Direct RAF Canvas Engine for zero React re-render PnL Chart
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
                    title: "REALTIME PnL EQUITY CURVE",
                    width,
                    height,
                    series: [
                        {},
                        {
                            label: "PnL ($)",
                            stroke: "#f59e0b", // Dark Yellow stroke
                            width: 2,
                        },
                    ],
                    axes: [
                        { show: false },
                        {
                            stroke: "#94a3b8",
                            size: 45,
                            font: "10px monospace",
                            grid: { stroke: "#1e293b", width: 1 },
                        },
                    ],
                };
                const count = history.count > 0 ? history.count : 1;
                const initialTs = history.count > 0 ? history.timestamps.subarray(0, count) : new Float64Array([Date.now() / 1000]);
                const initialPnl = history.count > 0 ? history.pnl.subarray(0, count) : new Float64Array([0]);
                try {
                    uplotInstance.current = new uplot_1.default(opts, [initialTs, initialPnl], container);
                }
                catch {
                    // Defensive catch for zero-dimension instantiation
                }
            }
            else {
                uplotInstance.current.setSize({ width, height });
            }
        };
        // Defensive ResizeObserver to guarantee positive canvas bounds
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
                const pnlSlice = history.pnl.subarray(0, history.count);
                uplotInstance.current.setData([tsSlice, pnlSlice]);
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
    return ((0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5", children: [(0, jsx_runtime_1.jsxs)("div", { className: "border-b border-yellow-600/30 pb-3 flex items-center justify-between", children: [(0, jsx_runtime_1.jsxs)("h2", { className: "text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2", children: [(0, jsx_runtime_1.jsx)("svg", { className: "w-5 h-5 text-yellow-500", fill: "none", stroke: "currentColor", viewBox: "0 0 24 24", children: (0, jsx_runtime_1.jsx)("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" }) }), "EXECUTION, INVENTORY & PnL LEDGER"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-xs text-yellow-400 font-mono", children: "ZERO-GC VIRTUOSO" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "REALIZED PnL" }), (0, jsx_runtime_1.jsx)("div", { ref: realizedPnlRef, className: "text-base font-bold text-emerald-400", children: "$0.00" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "UNREALIZED PnL" }), (0, jsx_runtime_1.jsx)("div", { ref: unrealizedPnlRef, className: "text-base font-bold text-emerald-400", children: "$0.00" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "WIN RATE" }), (0, jsx_runtime_1.jsx)("div", { ref: winRateRef, className: "text-base font-bold text-yellow-400", children: "0.0%" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "TOTAL TRADES" }), (0, jsx_runtime_1.jsx)("div", { ref: totalTradesRef, className: "text-base font-bold text-yellow-400", children: "0" })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between items-center text-xs", children: [(0, jsx_runtime_1.jsx)("span", { className: "font-bold text-yellow-500 uppercase", children: "ORDER BOOK IMBALANCE (OBI):" }), (0, jsx_runtime_1.jsx)("span", { ref: obiValRef, className: "font-mono text-yellow-400", children: "+0.0000" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "w-full bg-slate-800 h-3 rounded-full overflow-hidden flex", children: [(0, jsx_runtime_1.jsx)("div", { ref: obiBarGreenRef, className: "bg-emerald-500 h-full transition-all duration-100", style: { width: "50%" } }), (0, jsx_runtime_1.jsx)("div", { ref: obiBarRedRef, className: "bg-rose-500 h-full transition-all duration-100", style: { width: "50%" } })] }), (0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between text-xs text-slate-400 font-mono pt-1", children: [(0, jsx_runtime_1.jsxs)("span", { children: ["CVD: ", (0, jsx_runtime_1.jsx)("strong", { ref: cvdValRef, className: "text-yellow-400", children: "+0.00" })] }), (0, jsx_runtime_1.jsxs)("span", { children: ["BID/ASK: ", (0, jsx_runtime_1.jsx)("strong", { ref: bidPriceRef, className: "text-emerald-400", children: "$0.00" }), " / ", (0, jsx_runtime_1.jsx)("strong", { ref: askPriceRef, className: "text-rose-400", children: "$0.00" })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsx)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider", children: "PnL EQUITY CURVE STREAM (CANVAS 2D)" }), (0, jsx_runtime_1.jsx)("div", { ref: chartRef, className: "w-full h-36 min-h-[140px] flex items-center justify-center" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsxs)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider flex justify-between", children: [(0, jsx_runtime_1.jsx)("span", { children: "LIVE ORDER ROUTING FEED (VIRTUOSO VIRTUALIZED)" }), (0, jsx_runtime_1.jsxs)("span", { className: "text-slate-400 font-mono", children: [executions.length, " LOGS"] })] }), (0, jsx_runtime_1.jsx)("div", { className: "h-44 w-full", children: executions.length === 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "h-full flex items-center justify-center text-xs text-slate-500 font-mono", children: "[WAITING FOR HIGH-FREQUENCY EXECUTIONS...]" })) : ((0, jsx_runtime_1.jsx)(react_virtuoso_1.Virtuoso, { data: executions, computeItemKey: (_, item) => item.id, itemContent: (index, item) => ((0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between items-center py-1.5 px-2 border-b border-slate-800/60 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { className: `px-1.5 py-0.5 rounded font-bold text-[10px] ${item.side === "BUY" ? "bg-emerald-950 text-emerald-400 border border-emerald-600" : "bg-rose-950 text-rose-400 border border-rose-600"}`, children: item.side }), (0, jsx_runtime_1.jsx)("span", { className: "text-yellow-400", children: item.symbol })] }), (0, jsx_runtime_1.jsxs)("div", { className: "text-slate-300", children: ["$", item.price.toFixed(2)] }), (0, jsx_runtime_1.jsxs)("div", { className: "text-slate-400", children: [item.qty, " qty"] }), (0, jsx_runtime_1.jsxs)("div", { className: item.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400", children: ["$", item.realizedPnl.toFixed(2)] })] }, item.id || index)) })) })] })] }));
};
exports.ExecutionView = ExecutionView;
