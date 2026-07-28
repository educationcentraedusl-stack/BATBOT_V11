// Static 8-byte conversion buffer used for zero-allocation atomic float bitcasting
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);

export class MarketDataClient {
  private bigIntView: BigInt64Array;

  constructor(sab: SharedArrayBuffer) {
    if (sab.byteLength < 2048) {
      throw new Error("SharedArrayBuffer must be at least 2048 bytes");
    }
    this.bigIntView = new BigInt64Array(sab);
  }

  /**
   * Reads a 64-bit float slot atomically using a memory barrier via Atomics.load on BigInt64Array
   * and bitcasting the BigInt to a Float64 number using static conversion views (zero allocation).
   */
  private readAtomicFloat64(slot: number): number {
    const rawBits = Atomics.load(this.bigIntView, slot);
    BITCAST_BIGINT[0] = rawBits;
    return BITCAST_FLOAT[0];
  }

  public getTimestampNs(): bigint {
    return Atomics.load(this.bigIntView, 0);
  }

  public getOBI(): number {
    return this.readAtomicFloat64(1);
  }

  public getCVD(): number {
    return this.readAtomicFloat64(2);
  }

  public getSpreadVelocity(): number {
    return this.readAtomicFloat64(3);
  }

  public getBestBidPrice(): number {
    return this.readAtomicFloat64(4);
  }

  public getBestBidQuantity(): number {
    return this.readAtomicFloat64(5);
  }

  public getBestAskPrice(): number {
    return this.readAtomicFloat64(6);
  }

  public getBestAskQuantity(): number {
    return this.readAtomicFloat64(7);
  }

  public getLiquidationTotalVolume(): number {
    return this.readAtomicFloat64(8);
  }

  public getLiquidationBuyVolume(): number {
    return this.readAtomicFloat64(9);
  }

  public getLiquidationSellVolume(): number {
    return this.readAtomicFloat64(10);
  }

  /**
   * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Bids.
   * `outArray` format: [price0, qty0, price1, qty1, ...]
   */
  public fillTopBids(outArray: Float64Array, depth: number = 20): void {
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
  public fillTopAsks(outArray: Float64Array, depth: number = 20): void {
    const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
    for (let i = 0; i < count; i++) {
      const base = 51 + i * 2;
      outArray[i * 2] = this.readAtomicFloat64(base);
      outArray[i * 2 + 1] = this.readAtomicFloat64(base + 1);
    }
  }

  public getDroppedEvents(): bigint {
    return Atomics.load(this.bigIntView, 91);
  }

  public getSequenceNum(): bigint {
    return Atomics.load(this.bigIntView, 92);
  }

  // --- Slots 93 to 102: AI Prediction & Latency Metrics ---

  public getAIPredictionDirection(): number {
    return this.readAtomicFloat64(93);
  }

  public getAIPredictionConfidence(): number {
    return this.readAtomicFloat64(94);
  }

  public getAIPredictionHorizonMs(): number {
    return this.readAtomicFloat64(95);
  }

  public getAIPredictionTimestampNs(): bigint {
    return Atomics.load(this.bigIntView, 96);
  }

  public getMeasuredRttMs(): number {
    return this.readAtomicFloat64(98);
  }

  public getLatencyPenaltyCoefficient(): number {
    return this.readAtomicFloat64(99);
  }

  public getDynamicSlippageTicks(): number {
    return this.readAtomicFloat64(100);
  }

  public getRollingIC(): number {
    return this.readAtomicFloat64(101);
  }

  public getIsModelDrifted(): boolean {
    return this.readAtomicFloat64(102) > 0.5;
  }

  public getAIInferenceLatencyNs(): bigint {
    return Atomics.load(this.bigIntView, 103);
  }

  public getAIInferenceSequenceNum(): bigint {
    return Atomics.load(this.bigIntView, 104);
  }
}
