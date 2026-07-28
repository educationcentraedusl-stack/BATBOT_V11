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
const ExecutionView = () => {
    const state = (0, store_1.useTelemetryStore)();
    const frame = state.latestFrame;
    const history = state.history;
    const executions = state.executions;
    const chartRef = (0, react_1.useRef)(null);
    const uplotInstance = (0, react_1.useRef)(null);
    const obi = frame?.obi ?? 0;
    const cvd = frame?.cvd ?? 0;
    const realizedPnl = frame?.stats?.realizedPnl ?? 0;
    const unrealizedPnl = frame?.stats?.unrealizedPnl ?? 0;
    const winRate = frame?.stats?.winRatePercent ?? 0;
    const totalTrades = frame?.stats?.totalTrades ?? 0;
    // Initialize and update uPlot PnL Equity Chart
    (0, react_1.useEffect)(() => {
        if (!chartRef.current)
            return;
        if (!uplotInstance.current) {
            const opts = {
                title: "REALTIME PnL EQUITY CURVE",
                width: chartRef.current.clientWidth || 360,
                height: 140,
                series: [
                    {},
                    {
                        label: "PnL ($)",
                        stroke: "#f59e0b", // Strict Dark Yellow stroke
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
            const data = [
                history.timestamps.length ? history.timestamps : [Date.now() / 1000],
                history.pnl.length ? history.pnl : [0],
            ];
            uplotInstance.current = new uplot_1.default(opts, data, chartRef.current);
        }
        else {
            if (history.timestamps.length > 0) {
                uplotInstance.current.setData([history.timestamps, history.pnl]);
            }
        }
    }, [history.timestamps, history.pnl]);
    // Format OBI Bar percentage (-1..+1 -> 0%..100%)
    const obiNorm = ((Math.max(-1, Math.min(1, obi)) + 1) / 2) * 100;
    return ((0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5", children: [(0, jsx_runtime_1.jsxs)("div", { className: "border-b border-yellow-600/30 pb-3 flex items-center justify-between", children: [(0, jsx_runtime_1.jsxs)("h2", { className: "text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2", children: [(0, jsx_runtime_1.jsx)("svg", { className: "w-5 h-5 text-yellow-500", fill: "none", stroke: "currentColor", viewBox: "0 0 24 24", children: (0, jsx_runtime_1.jsx)("path", { strokeLinecap: "round", strokeLinejoin: "round", strokeWidth: "2", d: "M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" }) }), "EXECUTION, INVENTORY & PnL LEDGER"] }), (0, jsx_runtime_1.jsx)("span", { className: "text-xs text-yellow-400 font-mono", children: "ZERO-GC VIRTUOSO" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "REALIZED PnL" }), (0, jsx_runtime_1.jsxs)("div", { className: `text-base font-bold ${realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`, children: ["$", realizedPnl.toFixed(2)] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "UNREALIZED PnL" }), (0, jsx_runtime_1.jsxs)("div", { className: `text-base font-bold ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`, children: ["$", unrealizedPnl.toFixed(2)] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "WIN RATE" }), (0, jsx_runtime_1.jsxs)("div", { className: "text-base font-bold text-yellow-400", children: [winRate.toFixed(1), "%"] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-2.5 rounded border border-slate-800", children: [(0, jsx_runtime_1.jsx)("div", { className: "text-slate-500 mb-1", children: "TOTAL TRADES" }), (0, jsx_runtime_1.jsx)("div", { className: "text-base font-bold text-yellow-400", children: totalTrades })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between items-center text-xs", children: [(0, jsx_runtime_1.jsx)("span", { className: "font-bold text-yellow-500 uppercase", children: "ORDER BOOK IMBALANCE (OBI):" }), (0, jsx_runtime_1.jsx)("span", { className: "font-mono text-yellow-400", children: obi >= 0 ? `+${obi.toFixed(4)}` : obi.toFixed(4) })] }), (0, jsx_runtime_1.jsxs)("div", { className: "w-full bg-slate-800 h-3 rounded-full overflow-hidden flex", children: [(0, jsx_runtime_1.jsx)("div", { className: "bg-emerald-500 h-full transition-all duration-100", style: { width: `${obiNorm}%` } }), (0, jsx_runtime_1.jsx)("div", { className: "bg-rose-500 h-full transition-all duration-100", style: { width: `${100 - obiNorm}%` } })] }), (0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between text-xs text-slate-400 font-mono pt-1", children: [(0, jsx_runtime_1.jsxs)("span", { children: ["CVD: ", (0, jsx_runtime_1.jsx)("strong", { className: "text-yellow-400", children: cvd >= 0 ? `+${cvd.toFixed(2)}` : cvd.toFixed(2) })] }), (0, jsx_runtime_1.jsxs)("span", { children: ["BID/ASK: ", (0, jsx_runtime_1.jsxs)("strong", { className: "text-emerald-400", children: ["$", frame?.bidPrice.toFixed(2) || "0.00"] }), " / ", (0, jsx_runtime_1.jsxs)("strong", { className: "text-rose-400", children: ["$", frame?.askPrice.toFixed(2) || "0.00"] })] })] })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsx)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider", children: "PnL EQUITY CURVE STREAM (CANVAS 2D)" }), (0, jsx_runtime_1.jsx)("div", { ref: chartRef, className: "w-full h-36 flex items-center justify-center" })] }), (0, jsx_runtime_1.jsxs)("div", { className: "bg-slate-950 p-3 rounded border border-slate-800 space-y-2", children: [(0, jsx_runtime_1.jsxs)("h3", { className: "text-xs font-bold text-yellow-500 uppercase tracking-wider flex justify-between", children: [(0, jsx_runtime_1.jsx)("span", { children: "LIVE ORDER ROUTING FEED (VIRTUOSO VIRTUALIZED)" }), (0, jsx_runtime_1.jsxs)("span", { className: "text-slate-400 font-mono", children: [executions.length, " LOGS"] })] }), (0, jsx_runtime_1.jsx)("div", { className: "h-44 w-full", children: executions.length === 0 ? ((0, jsx_runtime_1.jsx)("div", { className: "h-full flex items-center justify-center text-xs text-slate-500 font-mono", children: "[WAITING FOR HIGH-FREQUENCY EXECUTIONS...]" })) : ((0, jsx_runtime_1.jsx)(react_virtuoso_1.Virtuoso, { data: executions, itemContent: (index, item) => ((0, jsx_runtime_1.jsxs)("div", { className: "flex justify-between items-center py-1.5 px-2 border-b border-slate-800/60 text-xs font-mono", children: [(0, jsx_runtime_1.jsxs)("div", { className: "flex items-center space-x-2", children: [(0, jsx_runtime_1.jsx)("span", { className: `px-1.5 py-0.5 rounded font-bold text-[10px] ${item.side === "BUY" ? "bg-emerald-950 text-emerald-400 border border-emerald-600" : "bg-rose-950 text-rose-400 border border-rose-600"}`, children: item.side }), (0, jsx_runtime_1.jsx)("span", { className: "text-yellow-400", children: item.symbol })] }), (0, jsx_runtime_1.jsxs)("div", { className: "text-slate-300", children: ["$", item.price.toFixed(2)] }), (0, jsx_runtime_1.jsxs)("div", { className: "text-slate-400", children: [item.qty, " qty"] }), (0, jsx_runtime_1.jsxs)("div", { className: item.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400", children: ["$", item.realizedPnl.toFixed(2)] })] }, item.id || index)) })) })] })] }));
};
exports.ExecutionView = ExecutionView;
