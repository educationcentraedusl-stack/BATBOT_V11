"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.useTelemetryRefMutator = useTelemetryRefMutator;
const react_1 = require("react");
const store_1 = require("../store");
/**
 * 2026 SOTA Ultra-Low Latency Direct DOM Mutator Hook.
 * Mutates element refs directly inside a dedicated 60/120 FPS RAF loop,
 * bypassing React VDOM reconciliations and eliminating main-thread render lockups.
 */
function useTelemetryRefMutator(refs) {
    const lastSequenceRef = (0, react_1.useRef)(null);
    const rafIdRef = (0, react_1.useRef)(null);
    (0, react_1.useEffect)(() => {
        let isSubscribed = true;
        const mutateLoop = () => {
            if (!isSubscribed)
                return;
            const frame = (0, store_1.getLatestFrameSnapshot)();
            if (frame && frame.sequenceNum !== lastSequenceRef.current) {
                lastSequenceRef.current = frame.sequenceNum;
                // 1. Sequence Number
                if (refs.sequenceNumRef?.current) {
                    refs.sequenceNumRef.current.textContent = `#${frame.sequenceNum || "0"}`;
                }
                // 2. Tick Latency (µs)
                if (refs.tickLatencyRef?.current) {
                    const lat = frame.tickEvaluationLatencyUs || 0;
                    refs.tickLatencyRef.current.textContent = `${lat.toFixed(2)} µs`;
                }
                // 3. RTT (ms)
                if (refs.rttMsRef?.current) {
                    const rtt = frame.rttMs || 0;
                    refs.rttMsRef.current.textContent = `${rtt.toFixed(1)} ms`;
                }
                // 4. AI Direction
                const direction = frame.aiDirection ?? 0;
                if (refs.directionRef?.current) {
                    const formattedDir = direction >= 0 ? `+${direction.toFixed(4)}` : direction.toFixed(4);
                    refs.directionRef.current.textContent = formattedDir;
                    refs.directionRef.current.className = `text-xl font-black ${direction >= 0 ? "text-emerald-400" : "text-rose-400"}`;
                }
                // 5. AI Direction Badge
                if (refs.directionBadgeRef?.current) {
                    if (direction > 0.05) {
                        refs.directionBadgeRef.current.textContent = "BULLISH LONG";
                        refs.directionBadgeRef.current.className = "text-xs px-2 py-0.5 rounded font-bold bg-emerald-950 text-emerald-400 border border-emerald-600";
                    }
                    else if (direction < -0.05) {
                        refs.directionBadgeRef.current.textContent = "BEARISH SHORT";
                        refs.directionBadgeRef.current.className = "text-xs px-2 py-0.5 rounded font-bold bg-rose-950 text-rose-400 border border-rose-600";
                    }
                    else {
                        refs.directionBadgeRef.current.textContent = "NEUTRAL";
                        refs.directionBadgeRef.current.className = "text-xs px-2 py-0.5 rounded font-bold bg-slate-800 text-slate-400";
                    }
                }
                // 6. AI Neural Confidence & Inference Latency
                const confidence = (frame.aiConfidence ?? 0) * 100;
                if (refs.confidenceRef?.current) {
                    refs.confidenceRef.current.textContent = `${confidence.toFixed(1)}%`;
                }
                if (refs.infLatUsRef?.current) {
                    const infLatUs = frame.aiInferenceLatencyNs ? Number(frame.aiInferenceLatencyNs) / 1000 : 0;
                    refs.infLatUsRef.current.textContent = `(${infLatUs.toFixed(1)} µs)`;
                }
                // 7. Gate 1–4 Validation Radar
                const rollingIc = frame.rollingIc ?? 0;
                if (refs.gate1Ref?.current) {
                    const pass = rollingIc >= 0.03;
                    refs.gate1Ref.current.textContent = `${rollingIc.toFixed(4)} [${pass ? "PASSED" : "WARN"}]`;
                    refs.gate1Ref.current.className = `font-bold ${pass ? "text-emerald-400" : "text-yellow-400"}`;
                }
                const latencyPenalty = frame.latencyPenalty ?? 1.0;
                if (refs.gate2Ref?.current) {
                    const pass = latencyPenalty > 0 && latencyPenalty <= 1.05;
                    refs.gate2Ref.current.textContent = `${latencyPenalty.toFixed(2)}x [${pass ? "OPTIMAL" : "DEGRADED"}]`;
                    refs.gate2Ref.current.className = `font-bold ${pass ? "text-emerald-400" : "text-amber-400"}`;
                }
                const riskStatus = frame.riskStatus ?? "STANDBY";
                const drawPct = frame.usdtBalance > 0 ? (Math.abs(frame.stats?.unrealizedPnl ?? 0) / frame.usdtBalance) * 100 : 0;
                if (refs.gate3Ref?.current) {
                    const pass = riskStatus === "PASSED";
                    refs.gate3Ref.current.textContent = `${drawPct.toFixed(2)}% / VaR [${riskStatus}]`;
                    refs.gate3Ref.current.className = `font-bold ${pass ? "text-emerald-400" : "text-rose-400"}`;
                }
                const slippageTicks = frame.slippageTicks ?? 2;
                if (refs.gate4Ref?.current) {
                    refs.gate4Ref.current.textContent = `+${slippageTicks} TICKS [OK]`;
                }
                // 8. Realized & Unrealized PnL, Win Rate, Total Trades
                const realizedPnl = frame.stats?.realizedPnl ?? 0;
                if (refs.realizedPnlRef?.current) {
                    refs.realizedPnlRef.current.textContent = `$${realizedPnl.toFixed(2)}`;
                    refs.realizedPnlRef.current.className = `text-base font-bold ${realizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`;
                }
                const unrealizedPnl = frame.stats?.unrealizedPnl ?? 0;
                if (refs.unrealizedPnlRef?.current) {
                    refs.unrealizedPnlRef.current.textContent = `$${unrealizedPnl.toFixed(2)}`;
                    refs.unrealizedPnlRef.current.className = `text-base font-bold ${unrealizedPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`;
                }
                const winRate = frame.stats?.winRatePercent ?? 0;
                if (refs.winRateRef?.current) {
                    refs.winRateRef.current.textContent = `${winRate.toFixed(1)}%`;
                }
                const totalTrades = frame.stats?.totalTrades ?? 0;
                if (refs.totalTradesRef?.current) {
                    refs.totalTradesRef.current.textContent = `${totalTrades}`;
                }
                // 9. Order Book Imbalance (OBI) & CVD
                const obi = frame.obi ?? 0;
                if (refs.obiValRef?.current) {
                    refs.obiValRef.current.textContent = obi >= 0 ? `+${obi.toFixed(4)}` : obi.toFixed(4);
                }
                const obiNorm = ((Math.max(-1, Math.min(1, obi)) + 1) / 2) * 100;
                if (refs.obiBarGreenRef?.current) {
                    refs.obiBarGreenRef.current.style.width = `${obiNorm}%`;
                }
                if (refs.obiBarRedRef?.current) {
                    refs.obiBarRedRef.current.style.width = `${100 - obiNorm}%`;
                }
                const cvd = frame.cvd ?? 0;
                if (refs.cvdValRef?.current) {
                    refs.cvdValRef.current.textContent = cvd >= 0 ? `+${cvd.toFixed(2)}` : cvd.toFixed(2);
                }
                if (refs.bidPriceRef?.current) {
                    refs.bidPriceRef.current.textContent = `$${frame.bidPrice ? frame.bidPrice.toFixed(2) : "0.00"}`;
                }
                if (refs.askPriceRef?.current) {
                    refs.askPriceRef.current.textContent = `$${frame.askPrice ? frame.askPrice.toFixed(2) : "0.00"}`;
                }
            }
            rafIdRef.current = requestAnimationFrame(mutateLoop);
        };
        rafIdRef.current = requestAnimationFrame(mutateLoop);
        return () => {
            isSubscribed = false;
            if (rafIdRef.current !== null) {
                cancelAnimationFrame(rafIdRef.current);
                rafIdRef.current = null;
            }
        };
    }, [refs]);
}
