import React, { useEffect, useRef } from "react";
import uPlot from "uplot";
import { Virtuoso } from "react-virtuoso";
import { useTelemetryStore } from "../store";

export const ExecutionView: React.FC = () => {
  const state = useTelemetryStore();
  const frame = state.latestFrame;
  const history = state.history;
  const executions = state.executions;

  const chartRef = useRef<HTMLDivElement>(null);
  const uplotInstance = useRef<uPlot | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const obi = frame?.obi ?? 0;
  const cvd = frame?.cvd ?? 0;
  const realizedPnl = frame?.stats?.realizedPnl ?? 0;
  const unrealizedPnl = frame?.stats?.unrealizedPnl ?? 0;
  const winRate = frame?.stats?.winRatePercent ?? 0;
  const totalTrades = frame?.stats?.totalTrades ?? 0;

  // Initialize ResizeObserver & Direct RAF Canvas Engine for zero React re-render PnL Chart
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;

    let isSubscribed = true;

    const initOrResizeChart = (width: number, height: number) => {
      if (width <= 0 || height <= 0 || !isSubscribed) return;

      if (!uplotInstance.current) {
        container.innerHTML = "";
        const opts: uPlot.Options = {
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
          uplotInstance.current = new uPlot(opts, [initialTs, initialPnl], container);
        } catch {
          // Defensive catch for zero-dimension instantiation
        }
      } else {
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
      if (!isSubscribed) return;

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

  // Format OBI Bar percentage (-1..+1 -> 0%..100%)
  const obiNorm = ((Math.max(-1, Math.min(1, obi)) + 1) / 2) * 100;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5">
      {/* Title strictly Dark Yellow */}
      <div className="border-b border-yellow-600/30 pb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2">
          <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
          </svg>
          EXECUTION, INVENTORY & PnL LEDGER
        </h2>
        <span className="text-xs text-yellow-400 font-mono">ZERO-GC VIRTUOSO</span>
      </div>

      {/* Account Inventory Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
        <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
          <div className="text-slate-500 mb-1">REALIZED PnL</div>
          <div className={`text-base font-bold ${realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            ${realizedPnl.toFixed(2)}
          </div>
        </div>

        <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
          <div className="text-slate-500 mb-1">UNREALIZED PnL</div>
          <div className={`text-base font-bold ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            ${unrealizedPnl.toFixed(2)}
          </div>
        </div>

        <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
          <div className="text-slate-500 mb-1">WIN RATE</div>
          <div className="text-base font-bold text-yellow-400">{winRate.toFixed(1)}%</div>
        </div>

        <div className="bg-slate-950 p-2.5 rounded border border-slate-800">
          <div className="text-slate-500 mb-1">TOTAL TRADES</div>
          <div className="text-base font-bold text-yellow-400">{totalTrades}</div>
        </div>
      </div>

      {/* Order Book Microstructure (OBI & CVD) */}
      <div className="bg-slate-950 p-3 rounded border border-slate-800 space-y-2">
        <div className="flex justify-between items-center text-xs">
          <span className="font-bold text-yellow-500 uppercase">ORDER BOOK IMBALANCE (OBI):</span>
          <span className="font-mono text-yellow-400">{obi >= 0 ? `+${obi.toFixed(4)}` : obi.toFixed(4)}</span>
        </div>

        {/* Visual OBI Progress Bar */}
        <div className="w-full bg-slate-800 h-3 rounded-full overflow-hidden flex">
          <div className="bg-emerald-500 h-full transition-all duration-100" style={{ width: `${obiNorm}%` }}></div>
          <div className="bg-rose-500 h-full transition-all duration-100" style={{ width: `${100 - obiNorm}%` }}></div>
        </div>

        <div className="flex justify-between text-xs text-slate-400 font-mono pt-1">
          <span>CVD: <strong className="text-yellow-400">{cvd >= 0 ? `+${cvd.toFixed(2)}` : cvd.toFixed(2)}</strong></span>
          <span>BID/ASK: <strong className="text-emerald-400">${frame?.bidPrice ? frame.bidPrice.toFixed(2) : "0.00"}</strong> / <strong className="text-rose-400">${frame?.askPrice ? frame.askPrice.toFixed(2) : "0.00"}</strong></span>
        </div>
      </div>

      {/* uPlot PnL Chart */}
      <div className="bg-slate-950 p-3 rounded border border-slate-800 space-y-2">
        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider">
          PnL EQUITY CURVE STREAM (CANVAS 2D)
        </h3>
        <div ref={chartRef} className="w-full h-36 min-h-[140px] flex items-center justify-center"></div>
      </div>

      {/* Virtualized Order Execution Log with react-virtuoso */}
      <div className="bg-slate-950 p-3 rounded border border-slate-800 space-y-2">
        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider flex justify-between">
          <span>LIVE ORDER ROUTING FEED (VIRTUOSO VIRTUALIZED)</span>
          <span className="text-slate-400 font-mono">{executions.length} LOGS</span>
        </h3>

        <div className="h-44 w-full">
          {executions.length === 0 ? (
            <div className="h-full flex items-center justify-center text-xs text-slate-500 font-mono">
              [WAITING FOR HIGH-FREQUENCY EXECUTIONS...]
            </div>
          ) : (
            <Virtuoso
              data={executions}
              computeItemKey={(_, item) => item.id}
              itemContent={(index, item) => (
                <div key={item.id || index} className="flex justify-between items-center py-1.5 px-2 border-b border-slate-800/60 text-xs font-mono">
                  <div className="flex items-center space-x-2">
                    <span className={`px-1.5 py-0.5 rounded font-bold text-[10px] ${item.side === "BUY" ? "bg-emerald-950 text-emerald-400 border border-emerald-600" : "bg-rose-950 text-rose-400 border border-rose-600"}`}>
                      {item.side}
                    </span>
                    <span className="text-yellow-400">{item.symbol}</span>
                  </div>
                  <div className="text-slate-300">${item.price.toFixed(2)}</div>
                  <div className="text-slate-400">{item.qty} qty</div>
                  <div className={item.realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    ${item.realizedPnl.toFixed(2)}
                  </div>
                </div>
              )}
            />
          )}
        </div>
      </div>
    </div>
  );
};
