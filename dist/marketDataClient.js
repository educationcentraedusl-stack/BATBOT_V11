"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MarketDataClient = void 0;
// Static 8-byte conversion buffer used for zero-allocation atomic float bitcasting
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);
class MarketDataClient {
    bigIntView;
    constructor(sab) {
        if (sab.byteLength < 2048) {
            throw new Error("SharedArrayBuffer must be at least 2048 bytes");
        }
        this.bigIntView = new BigInt64Array(sab);
    }
    /**
     * Reads a 64-bit float slot atomically using a memory barrier via Atomics.load on BigInt64Array
     * and bitcasting the BigInt to a Float64 number using static conversion views (zero allocation).
     */
    readAtomicFloat64(slot) {
        const rawBits = Atomics.load(this.bigIntView, slot);
        BITCAST_BIGINT[0] = rawBits;
        return BITCAST_FLOAT[0];
    }
    getTimestampNs() {
        return Atomics.load(this.bigIntView, 0);
    }
    getOBI() {
        return this.readAtomicFloat64(1);
    }
    getCVD() {
        return this.readAtomicFloat64(2);
    }
    getSpreadVelocity() {
        return this.readAtomicFloat64(3);
    }
    getBestBidPrice() {
        return this.readAtomicFloat64(4);
    }
    getBestBidQuantity() {
        return this.readAtomicFloat64(5);
    }
    getBestAskPrice() {
        return this.readAtomicFloat64(6);
    }
    getBestAskQuantity() {
        return this.readAtomicFloat64(7);
    }
    getLiquidationTotalVolume() {
        return this.readAtomicFloat64(8);
    }
    getLiquidationBuyVolume() {
        return this.readAtomicFloat64(9);
    }
    getLiquidationSellVolume() {
        return this.readAtomicFloat64(10);
    }
    /**
     * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Bids.
     * `outArray` format: [price0, qty0, price1, qty1, ...]
     */
    fillTopBids(outArray, depth = 20) {
        const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
        for (let i = 0; i < count; i++) {
            const base = 11 + i * 2;
            outArray[i * 2] = this.readAtomicFloat64(base);
            outArray[i * 2 + 1] = this.readAtomicFloat64(base + 1);
        }
    }
    /**
     * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Asks.
     * `outArray` format: [price0, qty0, price1, qty1, ...]
     */
    fillTopAsks(outArray, depth = 20) {
        const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
        for (let i = 0; i < count; i++) {
            const base = 51 + i * 2;
            outArray[i * 2] = this.readAtomicFloat64(base);
            outArray[i * 2 + 1] = this.readAtomicFloat64(base + 1);
        }
    }
    getDroppedEvents() {
        return Atomics.load(this.bigIntView, 91);
    }
    getSequenceNum() {
        return Atomics.load(this.bigIntView, 92);
    }
    // --- Slots 93 to 102: AI Prediction & Latency Metrics ---
    getAIPredictionDirection() {
        return this.readAtomicFloat64(93);
    }
    getAIPredictionConfidence() {
        return this.readAtomicFloat64(94);
    }
    getAIPredictionHorizonMs() {
        return this.readAtomicFloat64(95);
    }
    getAIPredictionTimestampNs() {
        return Atomics.load(this.bigIntView, 96);
    }
    getMeasuredRttMs() {
        return this.readAtomicFloat64(98);
    }
    getLatencyPenaltyCoefficient() {
        return this.readAtomicFloat64(99);
    }
    getDynamicSlippageTicks() {
        return this.readAtomicFloat64(100);
    }
    getRollingIC() {
        return this.readAtomicFloat64(101);
    }
    getIsModelDrifted() {
        return this.readAtomicFloat64(102) > 0.5;
    }
    getAIInferenceLatencyNs() {
        return Atomics.load(this.bigIntView, 103);
    }
    getAIInferenceSequenceNum() {
        return Atomics.load(this.bigIntView, 104);
    }
    // --- Slots 105 to 111: OMS Position Ledger Metrics ---
    getOmsPositionQty() {
        return this.readAtomicFloat64(105);
    }
    getOmsAvgEntryPrice() {
        return this.readAtomicFloat64(106);
    }
    getOmsRealizedPnl() {
        return this.readAtomicFloat64(107);
    }
    getOmsUnrealizedPnl() {
        return this.readAtomicFloat64(108);
    }
    getOmsLeverage() {
        return this.readAtomicFloat64(109);
    }
    getOmsCumVolumeUsd() {
        return this.readAtomicFloat64(110);
    }
    getOmsTotalTrades() {
        return Atomics.load(this.bigIntView, 111);
    }
    // --- Slots 112 to 120: Micro-Burst & Dynamic Dispersion Metrics ---
    writeAtomicFloat64(slot, value) {
        BITCAST_FLOAT[0] = value;
        Atomics.store(this.bigIntView, slot, BITCAST_BIGINT[0]);
    }
    getHawkesIntensity() {
        return this.readAtomicFloat64(112);
    }
    setHawkesIntensity(val) {
        this.writeAtomicFloat64(112, val);
    }
    getMicroburstScore() {
        return this.readAtomicFloat64(113);
    }
    setMicroburstScore(val) {
        this.writeAtomicFloat64(113, val);
    }
    getRealizedVolatility() {
        return this.readAtomicFloat64(114);
    }
    setRealizedVolatility(val) {
        this.writeAtomicFloat64(114, val);
    }
    getLastShortFillPrice() {
        return this.readAtomicFloat64(115);
    }
    setLastShortFillPrice(price) {
        this.writeAtomicFloat64(115, price);
    }
    getLastLongFillPrice() {
        return this.readAtomicFloat64(116);
    }
    setLastLongFillPrice(price) {
        this.writeAtomicFloat64(116, price);
    }
    getLastShortFillTime() {
        return this.readAtomicFloat64(117);
    }
    setLastShortFillTime(time) {
        this.writeAtomicFloat64(117, time);
    }
    getLastLongFillTime() {
        return this.readAtomicFloat64(118);
    }
    setLastLongFillTime(time) {
        this.writeAtomicFloat64(118, time);
    }
    getShortCooldownLock() {
        return this.readAtomicFloat64(119);
    }
    setShortCooldownLock(expiryMs) {
        this.writeAtomicFloat64(119, expiryMs);
    }
    getLongCooldownLock() {
        return this.readAtomicFloat64(120);
    }
    setLongCooldownLock(expiryMs) {
        this.writeAtomicFloat64(120, expiryMs);
    }
}
exports.MarketDataClient = MarketDataClient;
