"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketDataClient = void 0;
require("dotenv/config");
const tradingSymbols_1 = require("./config/tradingSymbols");
// Static 8-byte conversion buffer used for zero-allocation atomic float bitcasting
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);
const parsedDefaultMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "", 10);
const DEFAULT_MAX_CONCURRENT_ASSETS = Number.isFinite(parsedDefaultMaxAssets) && parsedDefaultMaxAssets > 0
    ? Math.max(parsedDefaultMaxAssets, (0, tradingSymbols_1.getTradingSymbols)().length)
    : (0, tradingSymbols_1.getTradingSymbols)().length;
const parsedDefaultSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
const DEFAULT_SAB_SLOTS_PER_ASSET = Number.isFinite(parsedDefaultSlotsPerAsset) && parsedDefaultSlotsPerAsset > 0 ? parsedDefaultSlotsPerAsset : 256;
class MarketDataClient {
    bigIntView;
    maxAssets;
    slotsPerAsset;
    totalSlots;
    requiredBytes;
    constructor(sab, maxAssets = DEFAULT_MAX_CONCURRENT_ASSETS, slotsPerAsset = DEFAULT_SAB_SLOTS_PER_ASSET) {
        this.maxAssets = maxAssets;
        this.slotsPerAsset = slotsPerAsset;
        this.totalSlots = maxAssets * slotsPerAsset;
        this.requiredBytes = this.totalSlots * 8;
        if (sab.byteLength < this.requiredBytes) {
            throw new Error(`SharedArrayBuffer must be at least ${this.requiredBytes} bytes for MAX_CONCURRENT_ASSETS=${maxAssets} and SAB_SLOTS_PER_ASSET=${slotsPerAsset} (received ${sab.byteLength} bytes)`);
        }
        this.bigIntView = new BigInt64Array(sab);
        this.cvdTimestamps = new Float64Array(this.maxAssets * this.cvdRingCap);
        this.cvdValues = new Float64Array(this.maxAssets * this.cvdRingCap);
        this.cvdHeads = new Int32Array(this.maxAssets);
        this.cvdCounts = new Int32Array(this.maxAssets);
        this.lastCvdUpdateTs = new Float64Array(this.maxAssets);
        this.lastCvdRecorded = new Float64Array(this.maxAssets);
    }
    /**
     * Dynamically calculates offset slot for (assetIdx, slot).
     * Strict fail-fast boundary enforcement: throws RangeError if index or slot is out of bounds.
     */
    getGlobalSlot(assetIdx, slot) {
        if (assetIdx < 0 || assetIdx >= this.maxAssets) {
            throw new RangeError(`assetIdx ${assetIdx} out of bounds (maxAssets: ${this.maxAssets})`);
        }
        if (slot < 0 || slot >= this.slotsPerAsset) {
            throw new RangeError(`slot ${slot} out of bounds (slotsPerAsset: ${this.slotsPerAsset})`);
        }
        const globalSlot = assetIdx * this.slotsPerAsset + slot;
        if (globalSlot >= this.totalSlots) {
            throw new RangeError(`globalSlot ${globalSlot} out of bounds (totalSlots: ${this.totalSlots})`);
        }
        return globalSlot;
    }
    /**
     * Reads a 64-bit float slot atomically using a memory barrier via Atomics.load on BigInt64Array
     * and bitcasting the BigInt to a Float64 number using static conversion views (zero allocation).
     */
    readAtomicFloat64Asset(assetIdx, slot) {
        const globalSlot = this.getGlobalSlot(assetIdx, slot);
        const rawBits = Atomics.load(this.bigIntView, globalSlot);
        BITCAST_BIGINT[0] = rawBits;
        return BITCAST_FLOAT[0];
    }
    /**
     * Writes a 64-bit float slot atomically using Atomics.store and static conversion views.
     */
    writeAtomicFloat64Asset(assetIdx, slot, value) {
        const globalSlot = this.getGlobalSlot(assetIdx, slot);
        BITCAST_FLOAT[0] = value;
        Atomics.store(this.bigIntView, globalSlot, BITCAST_BIGINT[0]);
    }
    getTimestampNs(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 0));
    }
    getOBI(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 1);
    }
    cvdRingCap = 1024;
    cvdTimestamps;
    cvdValues;
    cvdHeads;
    cvdCounts;
    lastCvdUpdateTs;
    lastCvdRecorded;
    getCVD(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 2);
    }
    /**
     * Calculates rolling volume-normalized CVD velocity over windowMs (default 5000ms).
     * Bounded in [-1.0, +1.0] using hyperbolic tangent to eliminate session-cumulative drift.
     * True rate-of-change velocity: Velocity = (Delta CVD / Delta t_sec) * 0.0005.
     * Zero GC allocation hot-path implementation.
     */
    getCVDVelocity(assetIdx = 0, windowMs = 5000, nowMs = Date.now()) {
        const safeAssetIdx = Math.max(0, Math.min(this.maxAssets - 1, assetIdx));
        const currentCvd = this.readAtomicFloat64Asset(safeAssetIdx, 2);
        const baseOffset = safeAssetIdx * this.cvdRingCap;
        let head = this.cvdHeads[safeAssetIdx];
        let count = this.cvdCounts[safeAssetIdx];
        if (count === 0 ||
            Math.abs(currentCvd - this.lastCvdRecorded[safeAssetIdx]) > 1e-6 ||
            nowMs - this.lastCvdUpdateTs[safeAssetIdx] >= 100) {
            const idx = baseOffset + head;
            this.cvdTimestamps[idx] = nowMs;
            this.cvdValues[idx] = currentCvd;
            this.lastCvdRecorded[safeAssetIdx] = currentCvd;
            this.lastCvdUpdateTs[safeAssetIdx] = nowMs;
            head = (head + 1) & 1023; // Modulo 1024
            this.cvdHeads[safeAssetIdx] = head;
            if (count < this.cvdRingCap) {
                count++;
                this.cvdCounts[safeAssetIdx] = count;
            }
        }
        if (count < 2) {
            return 0.0;
        }
        const targetTs = nowMs - windowMs;
        const oldestIdx = (head - count + 1024) & 1023;
        let baselineCvd = this.cvdValues[baseOffset + oldestIdx];
        let baselineTs = this.cvdTimestamps[baseOffset + oldestIdx];
        let low = 0;
        let high = count - 1;
        let bestIdx = -1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const ringIdx = (head - 1 - mid + 1024) & 1023;
            const ts = this.cvdTimestamps[baseOffset + ringIdx];
            if (ts <= targetTs) {
                bestIdx = ringIdx;
                high = mid - 1; // Seek newer timestamp closer to targetTs
            }
            else {
                low = mid + 1; // Seek older timestamp
            }
        }
        if (bestIdx >= 0) {
            baselineCvd = this.cvdValues[baseOffset + bestIdx];
            baselineTs = this.cvdTimestamps[baseOffset + bestIdx];
        }
        const elapsedMs = nowMs - baselineTs;
        if (elapsedMs < 200) {
            return 0.0;
        }
        const deltaCvd = currentCvd - baselineCvd;
        if (Math.abs(deltaCvd) < 1e-9) {
            return 0.0;
        }
        const elapsedSec = elapsedMs / 1000.0;
        const ratePerSecond = deltaCvd / elapsedSec;
        return Math.tanh(ratePerSecond * 0.0005);
    }
    getSpreadVelocity(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 3);
    }
    getBestBidPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 4);
    }
    getBestBidQuantity(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 5);
    }
    getBestAskPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 6);
    }
    getMidPrice(assetIdx = 0) {
        const bid = this.readAtomicFloat64Asset(assetIdx, 4);
        const ask = this.readAtomicFloat64Asset(assetIdx, 6);
        return bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : ask);
    }
    getBestAskQuantity(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 7);
    }
    getLiquidationTotalVolume(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 8);
    }
    getLiquidationBuyVolume(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 9);
    }
    getLiquidationSellVolume(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 10);
    }
    /**
     * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Bids.
     * `outArray` format: [price0, qty0, price1, qty1, ...]
     */
    fillTopBids(outArray, depth = 20, assetIdx = 0) {
        const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
        for (let i = 0; i < count; i++) {
            const base = 11 + i * 2;
            outArray[i * 2] = this.readAtomicFloat64Asset(assetIdx, base);
            outArray[i * 2 + 1] = this.readAtomicFloat64Asset(assetIdx, base + 1);
        }
    }
    /**
     * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Asks.
     * `outArray` format: [price0, qty0, price1, qty1, ...]
     */
    fillTopAsks(outArray, depth = 20, assetIdx = 0) {
        const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
        for (let i = 0; i < count; i++) {
            const base = 51 + i * 2;
            outArray[i * 2] = this.readAtomicFloat64Asset(assetIdx, base);
            outArray[i * 2 + 1] = this.readAtomicFloat64Asset(assetIdx, base + 1);
        }
    }
    getDroppedEvents(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 91));
    }
    getSequenceNum(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 92));
    }
    setSequenceNum(seq, assetIdx = 0) {
        Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 92), BigInt(seq));
    }
    // --- Slots 93 to 104: AI Prediction & Latency Metrics ---
    getAIPredictionDirection(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 93);
    }
    setAIPredictionDirection(dir, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 93, dir);
    }
    getAIPredictionConfidence(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 94);
    }
    setAIPredictionConfidence(conf, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 94, conf);
    }
    getAIPredictionHorizonMs(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 95);
    }
    getAIPredictionTimestampNs(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 96));
    }
    getMeasuredRttMs(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 98);
    }
    getLatencyPenaltyCoefficient(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 99);
    }
    getDynamicSlippageTicks(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 100);
    }
    setDynamicSlippageTicks(ticks, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 100, ticks);
    }
    // --- Slot 150: Binance Server Time Offset (EWMA NTP Drift in Milliseconds) ---
    getServerTimeOffsetMs(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 150);
    }
    setServerTimeOffsetMs(offsetMs, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 150, offsetMs);
    }
    setGlobalServerTimeOffsetMs(offsetMs) {
        for (let i = 0; i < this.maxAssets; i++) {
            this.writeAtomicFloat64Asset(i, 150, offsetMs);
        }
    }
    getRollingIC(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 101);
    }
    setRollingIC(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 101, val);
    }
    getIsModelDrifted(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 102) > 0.5;
    }
    setIsModelDrifted(isDrifted, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 102, isDrifted ? 1.0 : 0.0);
    }
    getAIInferenceLatencyNs(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 103));
    }
    getAIInferenceSequenceNum(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 104));
    }
    // --- Slots 105 to 111: OMS Position Ledger Metrics ---
    getOmsPositionQty(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 105);
    }
    setOmsPositionQty(qty, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 105, qty);
    }
    getOmsAvgEntryPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 106);
    }
    setOmsAvgEntryPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 106, price);
    }
    getOmsRealizedPnl(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 107);
    }
    setOmsRealizedPnl(pnl, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 107, pnl);
    }
    getOmsUnrealizedPnl(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 108);
    }
    setOmsUnrealizedPnl(pnl, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 108, pnl);
    }
    getOmsLeverage(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 109);
    }
    setOmsLeverage(lev, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 109, lev);
    }
    getOmsCumVolumeUsd(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 110);
    }
    getOmsTotalTrades(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 111));
    }
    setOmsTotalTrades(trades, assetIdx = 0) {
        Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 111), BigInt(trades));
    }
    getOmsWinningTrades(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 135));
    }
    setOmsWinningTrades(trades, assetIdx = 0) {
        Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 135), BigInt(trades));
    }
    getOmsLosingTrades(assetIdx = 0) {
        return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 136));
    }
    setOmsLosingTrades(trades, assetIdx = 0) {
        Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 136), BigInt(trades));
    }
    // --- Slots 112 to 120: Micro-Burst & Dynamic Dispersion Metrics ---
    getHawkesIntensity(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 112);
    }
    setHawkesIntensity(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 112, val);
    }
    setOBI(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 1, val);
    }
    setCVD(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 2, val);
    }
    getHurst(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 123);
    }
    setHurst(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 123, val);
    }
    getRealizedVolatility(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 114);
    }
    setRealizedVolatility(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 114, val);
    }
    getLastShortFillPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 115);
    }
    setLastShortFillPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 115, price);
    }
    getLastLongFillPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 116);
    }
    setLastLongFillPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 116, price);
    }
    getLastShortFillTime(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 117);
    }
    setLastShortFillTime(time, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 117, time);
    }
    getLastLongFillTime(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 118);
    }
    setLastLongFillTime(time, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 118, time);
    }
    getShortCooldownLock(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 119);
    }
    setShortCooldownLock(expiryMs, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 119, expiryMs);
    }
    getLongCooldownLock(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 120);
    }
    setLongCooldownLock(expiryMs, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 120, expiryMs);
    }
    // --- Slots 121 to 126: Dynamic Microstructure & Trap Metrics ---
    getGarmanKlassRV(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 121);
    }
    setGarmanKlassRV(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 121, val);
    }
    getVPIN(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 122);
    }
    setVPIN(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 122, val);
    }
    getHurstExponent(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 123);
    }
    setHurstExponent(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 123, val);
    }
    getLOBEntropy(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 124);
    }
    setLOBEntropy(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 124, val);
    }
    getRegimeStateCode(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 125);
    }
    setRegimeStateCode(code, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 125, code);
    }
    getIsSweepDetected(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 126) > 0.5;
    }
    setIsSweepDetected(isSweep, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 126, isSweep ? 1.0 : 0.0);
    }
    // --- Slots 127 to 129: AI Temperature Scaling & Platt Calibration Params ---
    getAiTemperature(assetIdx = 0) {
        const val = this.readAtomicFloat64Asset(assetIdx, 127);
        return val > 0.05 ? val : 1.0;
    }
    setAiTemperature(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 127, val);
    }
    getAiPlattScale(assetIdx = 0) {
        const val = this.readAtomicFloat64Asset(assetIdx, 128);
        return val > 0.05 ? val : 1.0;
    }
    setAiPlattScale(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 128, val);
    }
    getAiPlattOffset(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 129);
    }
    setAiPlattOffset(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 129, val);
    }
    // --- Slots 130 to 133: Atomic Interactive Control Flags & Emergency Kill Switches ---
    getKillSwitchFlag(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 130) > 0.5;
    }
    setKillSwitchFlag(active, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 130, active ? 1.0 : 0.0);
    }
    getCloseAllPositionsFlag(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 131) > 0.5;
    }
    setCloseAllPositionsFlag(trigger, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 131, trigger ? 1.0 : 0.0);
    }
    getEnginePausedFlag(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 132) > 0.5;
    }
    setEnginePausedFlag(paused, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 132, paused ? 1.0 : 0.0);
    }
    getTriggerRecalibrationFlag(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 133) > 0.5;
    }
    setTriggerRecalibrationFlag(trigger, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 133, trigger ? 1.0 : 0.0);
    }
    // --- Slot 134: Account Available Balance ---
    getAvailableBalance(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 134);
    }
    setAvailableBalance(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 134, val);
    }
    // --- Slot 137: Finalized Strategy Engine Signal State (0.0 = NONE, 1.0 = BUY, 2.0 = SELL) ---
    getFinalizedSignal(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 137);
    }
    setFinalizedSignal(signalVal, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 137, signalVal);
    }
    // --- Slots 138 to 141: SOTA Dynamic Exits & Microstructure Telemetry ---
    getOFI(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 138);
    }
    setOFI(ofiVal, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 138, ofiVal);
    }
    getHJBReservationPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 139);
    }
    setHJBReservationPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 139, price);
    }
    getSurvivalProbability(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 140);
    }
    setSurvivalProbability(prob, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 140, prob);
    }
    getDynamicStopLossPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 141);
    }
    setDynamicStopLossPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 141, price);
    }
    getOmsPositionSide(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 142);
    }
    setOmsPositionSide(code, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 142, code);
    }
    getOmsLongPositionQty(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 143);
    }
    setOmsLongPositionQty(qty, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 143, qty);
    }
    getOmsShortPositionQty(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 144);
    }
    setOmsShortPositionQty(qty, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 144, qty);
    }
    getOmsLongAvgEntryPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 145);
    }
    setOmsLongAvgEntryPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 145, price);
    }
    getOmsShortAvgEntryPrice(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 146);
    }
    setOmsShortAvgEntryPrice(price, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 146, price);
    }
    getOmsLongUnrealizedPnl(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 147);
    }
    setOmsLongUnrealizedPnl(pnl, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 147, pnl);
    }
    getOmsShortUnrealizedPnl(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 148);
    }
    setOmsShortUnrealizedPnl(pnl, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 148, pnl);
    }
    // --- Slot 149: Bivariate Hawkes Asymmetry ---
    getHawkesAsymmetry(assetIdx = 0) {
        return this.readAtomicFloat64Asset(assetIdx, 149);
    }
    setHawkesAsymmetry(val, assetIdx = 0) {
        this.writeAtomicFloat64Asset(assetIdx, 149, val);
    }
    /**
     * Broadcasts atomic Kill-Switch activation across all asset slots simultaneously.
     */
    setGlobalKillSwitch(active) {
        for (let i = 0; i < this.maxAssets; i++) {
            this.setKillSwitchFlag(active, i);
        }
    }
    /**
     * Broadcasts atomic Close-All-Positions trigger across all asset slots simultaneously.
     */
    setGlobalCloseAll(trigger) {
        for (let i = 0; i < this.maxAssets; i++) {
            this.setCloseAllPositionsFlag(trigger, i);
        }
    }
    /**
     * Broadcasts atomic Engine-Pause state across all asset slots simultaneously.
     */
    setGlobalPause(paused) {
        for (let i = 0; i < this.maxAssets; i++) {
            this.setEnginePausedFlag(paused, i);
        }
    }
    /**
     * Broadcasts atomic Trigger-Recalibration state across all asset slots simultaneously.
     */
    setGlobalRecalibration(trigger) {
        for (let i = 0; i < this.maxAssets; i++) {
            this.setTriggerRecalibrationFlag(trigger, i);
        }
    }
    /**
     * Zero-fills all SharedArrayBuffer slots across all assets to flush memory telemetry state.
     */
    flushTelemetry() {
        this.bigIntView.fill(0n);
        this.cvdTimestamps.fill(0);
        this.cvdValues.fill(0);
        this.cvdHeads.fill(0);
        this.cvdCounts.fill(0);
        this.lastCvdUpdateTs.fill(0);
        this.lastCvdRecorded.fill(0);
    }
}
exports.MarketDataClient = MarketDataClient;
