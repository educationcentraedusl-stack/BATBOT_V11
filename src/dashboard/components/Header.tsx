import React, { useRef } from "react";
import { useTelemetrySelector } from "../store";
import { useTelemetryRefMutator } from "../hooks/useTelemetryRefMutator";

export const Header: React.FC = () => {
  const connectionStatus = useTelemetrySelector((state) => state.connectionStatus);
  const isEngineActive = useTelemetrySelector((state) => state.isEngineActive);

  const isConnected = connectionStatus === "CONNECTED";

  const sequenceNumRef = useRef<HTMLSpanElement>(null);
  const tickLatencyRef = useRef<HTMLSpanElement>(null);
  const rttMsRef = useRef<HTMLSpanElement>(null);

  // Bind direct RAF DOM mutator for zero React VDOM re-renders
  useTelemetryRefMutator({
    sequenceNumRef,
    tickLatencyRef,
    rttMsRef,
  });

  return (
    <header className="bg-slate-900 border-b border-yellow-600/30 px-6 py-3.5 flex flex-wrap items-center justify-between shadow-lg">
      <div className="flex items-center space-x-4">
        {/* Strictly Dark Yellow Title */}
        <h1 className="text-xl font-extrabold tracking-wide text-yellow-500 uppercase flex items-center gap-2">
          <span className="w-3 h-3 rounded-full bg-yellow-500 animate-pulse"></span>
          BATBOT_V11 <span className="text-slate-400 font-medium text-sm">HFT TELEMETRY & CONTROL DASHBOARD</span>
        </h1>
      </div>

      <div className="flex items-center space-x-6 text-xs font-mono">
        {/* Connection Badge */}
        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-semibold">STREAM:</span>
          <span className={`px-2 py-0.5 rounded font-bold ${isConnected ? "bg-emerald-950 text-emerald-400 border border-emerald-600" : "bg-rose-950 text-rose-400 border border-rose-600"}`}>
            {connectionStatus}
          </span>
        </div>

        {/* Engine State */}
        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-semibold">ENGINE:</span>
          <span className={`px-2 py-0.5 rounded font-bold ${isEngineActive ? "bg-yellow-950 text-yellow-400 border border-yellow-500" : "bg-slate-800 text-slate-400"}`}>
            {isEngineActive ? "LIVE ACTIVE" : "IDLE / PAUSED"}
          </span>
        </div>

        {/* Sequence & Latency Metrics - Direct DOM Mutators */}
        <div className="hidden lg:flex items-center space-x-4 border-l border-slate-800 pl-4 text-slate-300">
          <div>
            <span className="text-slate-500">SEQ:</span> <span ref={sequenceNumRef} className="text-yellow-400 font-semibold">#0</span>
          </div>
          <div>
            <span className="text-slate-500">LATENCY:</span> <span ref={tickLatencyRef} className="text-yellow-400 font-semibold">0.00 µs</span>
          </div>
          <div>
            <span className="text-slate-500">RTT:</span> <span ref={rttMsRef} className="text-yellow-400 font-semibold">0.0 ms</span>
          </div>
        </div>
      </div>
    </header>
  );
};
