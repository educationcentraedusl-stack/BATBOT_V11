import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, m } from "framer-motion";
import { useTelemetrySelector, sendRpcCommand } from "../store";
import { Button } from "@/dashboard/components/ui/button";

export const ControlCenter: React.FC = () => {
  const isEngineActive = useTelemetrySelector((state) => state.isEngineActive);

  const [showKillModal, setShowKillModal] = useState(false);
  const [selectedModel, setSelectedModel] = useState("models/tkan_v2_optimized.bin");
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleNotice = (msg: string, durationMs: number): void => {
    if (noticeTimeoutRef.current !== null) {
      clearTimeout(noticeTimeoutRef.current);
    }
    setStatusNotice(msg);
    noticeTimeoutRef.current = setTimeout(() => {
      setStatusNotice(null);
      noticeTimeoutRef.current = null;
    }, durationMs);
  };

  useEffect(() => {
    return () => {
      if (noticeTimeoutRef.current !== null) {
        clearTimeout(noticeTimeoutRef.current);
        noticeTimeoutRef.current = null;
      }
    };
  }, []);

  const handleToggleEngine = (): void => {
    const action = isEngineActive ? "ENGINE_PAUSE" : "ENGINE_START";
    sendRpcCommand(action);
    scheduleNotice(`Requested ${action}...`, 3000);
  };

  const handleConfirmKill = (): void => {
    sendRpcCommand("EMERGENCY_KILL");
    setShowKillModal(false);
    scheduleNotice("EMERGENCY KILL SWITCH TRIGGERED!", 5000);
  };

  const handleHotSwap = (): void => {
    sendRpcCommand("AI_HOT_SWAP", selectedModel);
    scheduleNotice(`Triggered Hot-Swap for ${selectedModel}...`, 4000);
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-5 shadow-lg space-y-5">
      {/* Topic Title strictly Dark Yellow */}
      <div className="border-b border-yellow-600/30 pb-3 flex items-center justify-between">
        <h2 className="text-base font-bold text-yellow-500 uppercase tracking-wider flex items-center gap-2">
          <svg className="w-5 h-5 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
          ENGINE GOVERNANCE &amp; CONTROL
        </h2>
        <span className="text-xs text-yellow-400 font-mono">RPC GATEWAY: WS READY</span>
      </div>

      {statusNotice && (
        <div className="bg-yellow-950/80 border border-yellow-500 text-yellow-400 text-xs px-3 py-2 rounded font-mono">
          [SYSTEM NOTICE] {statusNotice}
        </div>
      )}

      {/* Primary Actions Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Button
          onClick={handleToggleEngine}
          className={`h-auto w-full py-3 px-4 rounded font-extrabold text-sm ${
            isEngineActive
              ? "bg-amber-600 hover:bg-amber-500 text-slate-950 border border-yellow-400"
              : "bg-yellow-500 hover:bg-yellow-400 text-slate-950 border border-yellow-300"
          }`}
        >
          {isEngineActive ? "PAUSE HFT ENGINE" : "START HFT ENGINE"}
        </Button>

        <Button
          variant="destructive"
          onClick={() => { setShowKillModal(true); }}
          className="h-auto w-full py-3 px-4 rounded font-black text-sm bg-rose-700 hover:bg-rose-600 text-white border border-rose-500"
        >
          <svg className="w-5 h-5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
          </svg>
          EMERGENCY KILL SWITCH
        </Button>
      </div>

      {/* AI Model Hot-Swap Section */}
      <div className="bg-slate-950 border border-slate-800 rounded p-4 space-y-3">
        <h3 className="text-xs font-bold text-yellow-500 uppercase tracking-wider">
          ATOMIC AI MODEL HOT-SWAP (ARC-SWAP &amp; SHADOW PRE-FLIGHT)
        </h3>

        <div className="flex flex-col sm:flex-row gap-3">
          <select
            value={selectedModel}
            onChange={(e) => { setSelectedModel(e.target.value); }}
            className="bg-slate-900 border border-yellow-600/40 text-yellow-300 text-xs rounded px-3 py-2 focus:outline-none focus:border-yellow-500 font-mono flex-1"
          >
            <option value="models/tkan_v2_optimized.bin">tkan_v2_optimized.bin (T-KAN Spline LUT)</option>
            <option value="models/cfc_hft_model.safetensors">cfc_hft_model.safetensors (CfC Recurrent Cell)</option>
            <option value="models/shadow_experiment_v3.bin">shadow_experiment_v3.bin (Experimental Model)</option>
          </select>

          <Button
            onClick={handleHotSwap}
            className="h-auto py-2 px-4 bg-yellow-600 hover:bg-yellow-500 text-slate-950 font-bold text-xs rounded border border-yellow-400"
          >
            EXECUTE HOT-SWAP
          </Button>
        </div>
      </div>

      {/* Dual Confirmation Modal for Emergency Kill (LazyMotion modal transition only) */}
      <AnimatePresence>
        {showKillModal && (
          <m.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 bg-slate-950/90 backdrop-blur-md flex items-center justify-center p-4 z-50"
          >
            <m.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              transition={{ duration: 0.18, ease: "easeOut" }}
              className="bg-slate-900 border-2 border-rose-600 rounded-lg max-w-md w-full p-6 space-y-5 shadow-2xl"
            >
              <h2 className="text-lg font-black text-rose-500 uppercase tracking-wider flex items-center gap-2">
                ⚠️ EMERGENCY KILL SWITCH CONFIRMATION
              </h2>
              <p className="text-xs text-slate-300 leading-relaxed font-mono">
                THIS ACTION WILL IMMEDIATELY CANCEL ALL PENDING ORDERS, FLATTEN ACTIVE INVENTORY (MARKET SELL/BUY), AND HARD-HALT THE RUST TICK EVALUATION LOOP.
              </p>

              <div className="flex gap-4">
                <Button
                  variant="destructive"
                  onClick={handleConfirmKill}
                  className="h-auto flex-1 py-3 bg-rose-600 hover:bg-rose-500 text-white font-extrabold text-xs"
                >
                  CONFIRM KILL &amp; FLATTEN
                </Button>
                <Button
                  variant="outline"
                  onClick={() => { setShowKillModal(false); }}
                  className="h-auto flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-yellow-400 font-bold text-xs border-yellow-600/30"
                >
                  CANCEL
                </Button>
              </div>
            </m.div>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
};
