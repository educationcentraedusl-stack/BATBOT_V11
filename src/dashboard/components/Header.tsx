import React from "react";
import { useTelemetryStore } from "../store";

export const Header: React.FC = () => {
  const state = useTelemetryStore();
  const frame = state.latestFrame;

  const isConnected = state.connectionStatus === "CONNECTED";
  const isActive = frame?.isEngineActive ?? false;

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
            {state.connectionStatus}
          </span>
        </div>

        {/* Engine State */}
        <div className="flex items-center space-x-2">
          <span className="text-slate-400 font-semibold">ENGINE:</span>
          <span className={`px-2 py-0.5 rounded font-bold ${isActive ? "bg-yellow-950 text-yellow-400 border border-yellow-500" : "bg-slate-800 text-slate-400"}`}>
            {isActive ? "LIVE ACTIVE" : "IDLE / PAUSED"}
          </span>
        </div>

        {/* Sequence & Latency Metrics */}
        <div className="hidden lg:flex items-center space-x-4 border-l border-slate-800 pl-4 text-slate-300">
          <div>
            <span className="text-slate-500">SEQ:</span> <span className="text-yellow-400 font-semibold">#{frame?.sequenceNum || "0"}</span>
          </div>
          <div>
            <span className="text-slate-500">LATENCY:</span> <span className="text-yellow-400 font-semibold">{(frame?.tickEvaluationLatencyUs || 0).toFixed(2)} µs</span>
          </div>
          <div>
            <span className="text-slate-500">RTT:</span> <span className="text-yellow-400 font-semibold">{(frame?.rttMs || 0).toFixed(1)} ms</span>
          </div>
        </div>
      </div>
    </header>
  );
};
