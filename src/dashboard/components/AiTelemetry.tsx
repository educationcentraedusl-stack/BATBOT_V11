import React, { useEffect, useRef } from "react";
import uPlot from "uplot";
import { getHistorySnapshot } from "../store";
import { useTelemetryRefMutator } from "../hooks/useTelemetryRefMutator";

export const AiTelemetry: React.FC = () => {
  const chartRef = useRef<HTMLDivElement>(null);
  const uplotInstance = useRef<uPlot | null>(null);
  const rafIdRef = useRef<number | null>(null);

  // Direct DOM Mutator Refs for 0-VDOM Render Metric Updating
  const directionRef = useRef<HTMLSpanElement>(null);
  const directionBadgeRef = useRef<HTMLSpanElement>(null);
  const confidenceRef = useRef<HTMLSpanElement>(null);
  const infLatUsRef = useRef<HTMLSpanElement>(null);
  const gate1Ref = useRef<HTMLSpanElement>(null);
  const gate2Ref = useRef<HTMLSpanElement>(null);
  const gate3Ref = useRef<HTMLSpanElement>(null);
  const gate4Ref = useRef<HTMLSpanElement>(null);

  useTelemetryRefMutator({
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
  useEffect(() => {
    const container = chartRef.current;
    if (!container) return;

    let isSubscribed = true;
    const history = getHistorySnapshot();

    const initOrResizeChart = (width: number, height: number) => {
      if (width <= 0 || height <= 0 || !isSubscribed) return;

      if (!uplotInstance.current) {
        container.innerHTML = "";
        const opts: uPlot.Options = {
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
          uplotInstance.current = new uPlot(opts, [initialTs, initialNorms], container);
        } catch {
          // Prevent crash on zero dimensions or invalid DOM state
        }
      } else {
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
      if (!isSubscribed) return;

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

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5">
      {/* Title strictly Dark Yellow */}
      <div className="border-b border-yellow-600/30 pb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2">
          <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
          AI TELEMETRY & SHADOW INSPECTOR
        </h2>
        <span className="text-xs text-yellow-400 font-mono">T-KAN + CfC CELL</span>
      </div>

      {/* Signal Direction & Confidence Meter - Direct DOM Mutators */}
      <div className="grid grid-cols-2 gap-4 bg-slate-950 p-4 rounded border border-slate-800">
        <div>
          <div className="text-xs text-slate-400 font-semibold mb-1">PREDICTED DIRECTION</div>
          <div className="flex items-center space-x-2">
            <span ref={directionRef} className="text-xl font-black text-slate-400">+0.0000</span>
            <span ref={directionBadgeRef} className="text-xs px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-400">NEUTRAL</span>
          </div>
        </div>

        <div>
          <div className="text-xs text-slate-400 font-semibold mb-1">NEURAL CONFIDENCE</div>
          <div className="flex items-center space-x-2">
            <span ref={confidenceRef} className="text-xl font-black text-yellow-400">0.0%</span>
            <span ref={infLatUsRef} className="text-xs text-slate-400 font-mono">(0.0 µs)</span>
          </div>
        </div>
      </div>

      {/* Pre-Flight Validation Gates Status Radar - Direct DOM Mutators */}
      <div className="space-y-2">
        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider">
          GATE 1–4 PRE-FLIGHT VALIDATION RADAR
        </h3>

        <div className="grid grid-cols-2 gap-2 text-xs font-mono">
          <div className="bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center">
            <span className="text-slate-300">GATE 1 (SPEARMAN IC &gt; 0.03):</span>
            <span ref={gate1Ref} className="font-bold text-slate-500">0.0000 [STANDBY]</span>
          </div>

          <div className="bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center">
            <span className="text-slate-300">GATE 2 (LATENCY PENALTY):</span>
            <span ref={gate2Ref} className="font-bold text-slate-500">0.00x [STANDBY]</span>
          </div>

          <div className="bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center">
            <span className="text-slate-300">GATE 3 (RISK COLLAR / VaR):</span>
            <span ref={gate3Ref} className="font-bold text-slate-500">0.00% / - [STANDBY]</span>
          </div>

          <div className="bg-slate-950 p-2.5 rounded border border-slate-800 flex justify-between items-center">
            <span className="text-slate-300">GATE 4 (SLIPPAGE BUFFER):</span>
            <span ref={gate4Ref} className="font-bold text-slate-500">0 TICKS [STANDBY]</span>
          </div>
        </div>
      </div>

      {/* uPlot Canvas Chart Container for State Norms */}
      <div className="bg-slate-950 p-3 rounded border border-slate-800 space-y-2">
        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider">
          CfC RECURRENT CELL STATE NORM (CANVAS 2D)
        </h3>
        <div ref={chartRef} className="w-full h-36 min-h-[140px] flex items-center justify-center"></div>
      </div>
    </div>
  );
};
