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
        if (sab.byteLength < 1024) {
            throw new Error("SharedArrayBuffer must be at least 1024 bytes");
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
}
exports.MarketDataClient = MarketDataClient;
