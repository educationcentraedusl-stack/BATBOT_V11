import React, { useEffect } from "react";
import { initTelemetryWorker } from "./store";
import { Header } from "./components/Header";
import { ControlCenter } from "./components/ControlCenter";
import { AiTelemetry } from "./components/AiTelemetry";
import { ExecutionView } from "./components/ExecutionView";

export const App: React.FC = () => {
  useEffect(() => {
    // Initialize WebWorker connection to Node.js telemetry server on port 8080
    const wsHost = window.location.hostname || "localhost";
    initTelemetryWorker(`ws://${wsHost}:8080`);
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <Header />

      <main className="flex-1 p-4 md:p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-[1800px] w-full mx-auto">
        {/* Column 1: Control Center & Engine Governance */}
        <div className="space-y-6">
          <ControlCenter />
        </div>

        {/* Column 2: AI Telemetry & Shadow Inspector */}
        <div className="space-y-6">
          <AiTelemetry />
        </div>

        {/* Column 3: Execution, Virtuoso Order Ledger & PnL View */}
        <div className="space-y-6">
          <ExecutionView />
        </div>
      </main>
    </div>
  );
};

export default App;
