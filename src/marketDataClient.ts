import "dotenv/config";
import { getTradingSymbols } from "./config/tradingSymbols";

// Static 8-byte conversion buffer used for zero-allocation atomic float bitcasting
const BITCAST_BUF = new ArrayBuffer(8);
const BITCAST_BIGINT = new BigInt64Array(BITCAST_BUF);
const BITCAST_FLOAT = new Float64Array(BITCAST_BUF);

const parsedDefaultMaxAssets = parseInt(process.env.MAX_CONCURRENT_ASSETS || "", 10);
const DEFAULT_MAX_CONCURRENT_ASSETS =
  Number.isFinite(parsedDefaultMaxAssets) && parsedDefaultMaxAssets > 0
    ? Math.max(parsedDefaultMaxAssets, getTradingSymbols().length)
    : getTradingSymbols().length;

const parsedDefaultSlotsPerAsset = parseInt(process.env.SAB_SLOTS_PER_ASSET || "256", 10);
const DEFAULT_SAB_SLOTS_PER_ASSET =
  Number.isFinite(parsedDefaultSlotsPerAsset) && parsedDefaultSlotsPerAsset > 0 ? parsedDefaultSlotsPerAsset : 256;


export class MarketDataClient {
  private bigIntView: BigInt64Array;
  public readonly maxAssets: number;
  public readonly slotsPerAsset: number;
  public readonly totalSlots: number;
  public readonly requiredBytes: number;

  constructor(
    sab: SharedArrayBuffer,
    maxAssets: number = DEFAULT_MAX_CONCURRENT_ASSETS,
    slotsPerAsset: number = DEFAULT_SAB_SLOTS_PER_ASSET
  ) {
    this.maxAssets = maxAssets;
    this.slotsPerAsset = slotsPerAsset;
    this.totalSlots = maxAssets * slotsPerAsset;
    this.requiredBytes = this.totalSlots * 8;

    if (sab.byteLength < this.requiredBytes) {
      throw new Error(
        `SharedArrayBuffer must be at least ${this.requiredBytes} bytes for MAX_CONCURRENT_ASSETS=${maxAssets} and SAB_SLOTS_PER_ASSET=${slotsPerAsset} (received ${sab.byteLength} bytes)`
      );
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
  private getGlobalSlot(assetIdx: number, slot: number): number {
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
  public readAtomicFloat64Asset(assetIdx: number, slot: number): number {
    const globalSlot = this.getGlobalSlot(assetIdx, slot);
    const rawBits = Atomics.load(this.bigIntView, globalSlot);
    BITCAST_BIGINT[0] = rawBits;
    return BITCAST_FLOAT[0];
  }

  /**
   * Writes a 64-bit float slot atomically using Atomics.store and static conversion views.
   */
  public writeAtomicFloat64Asset(assetIdx: number, slot: number, value: number): void {
    const globalSlot = this.getGlobalSlot(assetIdx, slot);
    BITCAST_FLOAT[0] = value;
    Atomics.store(this.bigIntView, globalSlot, BITCAST_BIGINT[0]);
  }

  public getTimestampNs(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 0));
  }

  public getOBI(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 1);
  }

  private readonly cvdRingCap: number = 1024;
  private readonly cvdTimestamps: Float64Array;
  private readonly cvdValues: Float64Array;
  private readonly cvdHeads: Int32Array;
  private readonly cvdCounts: Int32Array;
  private readonly lastCvdUpdateTs: Float64Array;
  private readonly lastCvdRecorded: Float64Array;

  public getCVD(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 2);
  }

  /**
   * Calculates rolling volume-normalized CVD velocity over windowMs (default 5000ms).
   * Bounded in [-1.0, +1.0] using hyperbolic tangent to eliminate session-cumulative drift.
   * True rate-of-change velocity: Velocity = (Delta CVD / Delta t_sec) * 0.0005.
   * Zero GC allocation hot-path implementation.
   */
  public getCVDVelocity(assetIdx: number = 0, windowMs: number = 5000, nowMs: number = Date.now()): number {
    const safeAssetIdx = Math.max(0, Math.min(this.maxAssets - 1, assetIdx));
    const currentCvd = this.readAtomicFloat64Asset(safeAssetIdx, 2);

    const baseOffset = safeAssetIdx * this.cvdRingCap;
    let head = this.cvdHeads[safeAssetIdx];
    let count = this.cvdCounts[safeAssetIdx];

    if (
      count === 0 ||
      Math.abs(currentCvd - this.lastCvdRecorded[safeAssetIdx]) > 1e-6 ||
      nowMs - this.lastCvdUpdateTs[safeAssetIdx] >= 100
    ) {
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
      } else {
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

  public getSpreadVelocity(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 3);
  }

  public getBestBidPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 4);
  }

  public getBestBidQuantity(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 5);
  }

  public getBestAskPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 6);
  }

  public getMidPrice(assetIdx: number = 0): number {
    const bid = this.readAtomicFloat64Asset(assetIdx, 4);
    const ask = this.readAtomicFloat64Asset(assetIdx, 6);
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid > 0 ? bid : ask);
  }

  public getBestAskQuantity(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 7);
  }

  public getLiquidationTotalVolume(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 8);
  }

  public getLiquidationBuyVolume(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 9);
  }

  public getLiquidationSellVolume(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 10);
  }

  /**
   * Zero-allocation reader method to populate pre-allocated target Float64Array with Top Bids.
   * `outArray` format: [price0, qty0, price1, qty1, ...]
   */
  public fillTopBids(outArray: Float64Array, depth: number = 20, assetIdx: number = 0): void {
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
  public fillTopAsks(outArray: Float64Array, depth: number = 20, assetIdx: number = 0): void {
    const count = Math.min(depth, 20, Math.floor(outArray.length / 2));
    for (let i = 0; i < count; i++) {
      const base = 51 + i * 2;
      outArray[i * 2] = this.readAtomicFloat64Asset(assetIdx, base);
      outArray[i * 2 + 1] = this.readAtomicFloat64Asset(assetIdx, base + 1);
    }
  }

  public getDroppedEvents(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 91));
  }

  public getSequenceNum(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 92));
  }

  // --- Slots 93 to 104: AI Prediction & Latency Metrics ---

  public getAIPredictionDirection(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 93);
  }

  public getAIPredictionConfidence(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 94);
  }

  public getAIPredictionHorizonMs(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 95);
  }

  public getAIPredictionTimestampNs(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 96));
  }

  public getMeasuredRttMs(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 98);
  }

  public getLatencyPenaltyCoefficient(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 99);
  }

  public getDynamicSlippageTicks(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 100);
  }

  public setDynamicSlippageTicks(ticks: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 100, ticks);
  }

  // --- Slot 150: Binance Server Time Offset (EWMA NTP Drift in Milliseconds) ---
  public getServerTimeOffsetMs(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 150);
  }

  public setServerTimeOffsetMs(offsetMs: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 150, offsetMs);
  }

  public setGlobalServerTimeOffsetMs(offsetMs: number): void {
    for (let i = 0; i < this.maxAssets; i++) {
      this.writeAtomicFloat64Asset(i, 150, offsetMs);
    }
  }

  public getRollingIC(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 101);
  }

  public setRollingIC(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 101, val);
  }

  public getIsModelDrifted(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 102) > 0.5;
  }

  public setIsModelDrifted(isDrifted: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 102, isDrifted ? 1.0 : 0.0);
  }

  public getAIInferenceLatencyNs(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 103));
  }

  public getAIInferenceSequenceNum(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 104));
  }

  // --- Slots 105 to 111: OMS Position Ledger Metrics ---

  public getOmsPositionQty(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 105);
  }

  public setOmsPositionQty(qty: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 105, qty);
  }

  public getOmsAvgEntryPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 106);
  }

  public setOmsAvgEntryPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 106, price);
  }

  public getOmsRealizedPnl(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 107);
  }

  public setOmsRealizedPnl(pnl: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 107, pnl);
  }

  public getOmsUnrealizedPnl(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 108);
  }

  public setOmsUnrealizedPnl(pnl: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 108, pnl);
  }

  public getOmsLeverage(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 109);
  }

  public setOmsLeverage(lev: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 109, lev);
  }

  public getOmsCumVolumeUsd(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 110);
  }

  public getOmsTotalTrades(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 111));
  }

  public setOmsTotalTrades(trades: bigint | number, assetIdx: number = 0): void {
    Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 111), BigInt(trades));
  }

  public getOmsWinningTrades(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 135));
  }

  public setOmsWinningTrades(trades: bigint | number, assetIdx: number = 0): void {
    Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 135), BigInt(trades));
  }

  public getOmsLosingTrades(assetIdx: number = 0): bigint {
    return Atomics.load(this.bigIntView, this.getGlobalSlot(assetIdx, 136));
  }

  public setOmsLosingTrades(trades: bigint | number, assetIdx: number = 0): void {
    Atomics.store(this.bigIntView, this.getGlobalSlot(assetIdx, 136), BigInt(trades));
  }

  // --- Slots 112 to 120: Micro-Burst & Dynamic Dispersion Metrics ---

  public getHawkesIntensity(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 112);
  }

  public setHawkesIntensity(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 112, val);
  }

  public setOBI(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 1, val);
  }

  public setCVD(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 2, val);
  }

  public getHurst(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 123);
  }

  public setHurst(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 123, val);
  }

  public getRealizedVolatility(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 114);
  }

  public setRealizedVolatility(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 114, val);
  }

  public getLastShortFillPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 115);
  }

  public setLastShortFillPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 115, price);
  }

  public getLastLongFillPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 116);
  }

  public setLastLongFillPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 116, price);
  }

  public getLastShortFillTime(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 117);
  }

  public setLastShortFillTime(time: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 117, time);
  }

  public getLastLongFillTime(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 118);
  }

  public setLastLongFillTime(time: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 118, time);
  }

  public getShortCooldownLock(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 119);
  }

  public setShortCooldownLock(expiryMs: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 119, expiryMs);
  }

  public getLongCooldownLock(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 120);
  }

  public setLongCooldownLock(expiryMs: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 120, expiryMs);
  }

  // --- Slots 121 to 126: Dynamic Microstructure & Trap Metrics ---

  public getGarmanKlassRV(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 121);
  }

  public setGarmanKlassRV(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 121, val);
  }

  public getVPIN(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 122);
  }

  public setVPIN(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 122, val);
  }

  public getHurstExponent(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 123);
  }

  public setHurstExponent(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 123, val);
  }

  public getLOBEntropy(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 124);
  }

  public setLOBEntropy(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 124, val);
  }

  public getRegimeStateCode(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 125);
  }

  public setRegimeStateCode(code: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 125, code);
  }

  public getIsSweepDetected(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 126) > 0.5;
  }

  public setIsSweepDetected(isSweep: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 126, isSweep ? 1.0 : 0.0);
  }

  // --- Slots 127 to 129: AI Temperature Scaling & Platt Calibration Params ---

  public getAiTemperature(assetIdx: number = 0): number {
    const val = this.readAtomicFloat64Asset(assetIdx, 127);
    return val > 0.05 ? val : 1.0;
  }

  public setAiTemperature(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 127, val);
  }

  public getAiPlattScale(assetIdx: number = 0): number {
    const val = this.readAtomicFloat64Asset(assetIdx, 128);
    return val > 0.05 ? val : 1.0;
  }

  public setAiPlattScale(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 128, val);
  }

  public getAiPlattOffset(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 129);
  }

  public setAiPlattOffset(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 129, val);
  }

  // --- Slots 130 to 133: Atomic Interactive Control Flags & Emergency Kill Switches ---

  public getKillSwitchFlag(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 130) > 0.5;
  }

  public setKillSwitchFlag(active: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 130, active ? 1.0 : 0.0);
  }

  public getCloseAllPositionsFlag(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 131) > 0.5;
  }

  public setCloseAllPositionsFlag(trigger: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 131, trigger ? 1.0 : 0.0);
  }

  public getEnginePausedFlag(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 132) > 0.5;
  }

  public setEnginePausedFlag(paused: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 132, paused ? 1.0 : 0.0);
  }

  public getTriggerRecalibrationFlag(assetIdx: number = 0): boolean {
    return this.readAtomicFloat64Asset(assetIdx, 133) > 0.5;
  }

  public setTriggerRecalibrationFlag(trigger: boolean, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 133, trigger ? 1.0 : 0.0);
  }

  // --- Slot 134: Account Available Balance ---

  public getAvailableBalance(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 134);
  }

  public setAvailableBalance(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 134, val);
  }

  // --- Slot 137: Finalized Strategy Engine Signal State (0.0 = NONE, 1.0 = BUY, 2.0 = SELL) ---

  public getFinalizedSignal(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 137);
  }

  public setFinalizedSignal(signalVal: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 137, signalVal);
  }

  // --- Slots 138 to 141: SOTA Dynamic Exits & Microstructure Telemetry ---

  public getOFI(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 138);
  }

  public setOFI(ofiVal: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 138, ofiVal);
  }

  public getHJBReservationPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 139);
  }

  public setHJBReservationPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 139, price);
  }

  public getSurvivalProbability(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 140);
  }

  public setSurvivalProbability(prob: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 140, prob);
  }

  public getDynamicStopLossPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 141);
  }

  public setDynamicStopLossPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 141, price);
  }

  public getOmsPositionSide(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 142);
  }

  public setOmsPositionSide(code: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 142, code);
  }

  public getOmsLongPositionQty(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 143);
  }

  public setOmsLongPositionQty(qty: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 143, qty);
  }

  public getOmsShortPositionQty(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 144);
  }

  public setOmsShortPositionQty(qty: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 144, qty);
  }

  public getOmsLongAvgEntryPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 145);
  }

  public setOmsLongAvgEntryPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 145, price);
  }

  public getOmsShortAvgEntryPrice(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 146);
  }

  public setOmsShortAvgEntryPrice(price: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 146, price);
  }

  public getOmsLongUnrealizedPnl(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 147);
  }

  public setOmsLongUnrealizedPnl(pnl: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 147, pnl);
  }

  public getOmsShortUnrealizedPnl(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 148);
  }

  public setOmsShortUnrealizedPnl(pnl: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 148, pnl);
  }

  // --- Slot 149: Bivariate Hawkes Asymmetry ---

  public getHawkesAsymmetry(assetIdx: number = 0): number {
    return this.readAtomicFloat64Asset(assetIdx, 149);
  }

  public setHawkesAsymmetry(val: number, assetIdx: number = 0): void {
    this.writeAtomicFloat64Asset(assetIdx, 149, val);
  }


  /**
   * Broadcasts atomic Kill-Switch activation across all asset slots simultaneously.
   */
  public setGlobalKillSwitch(active: boolean): void {
    for (let i = 0; i < this.maxAssets; i++) {
      this.setKillSwitchFlag(active, i);
    }
  }

  /**
   * Broadcasts atomic Close-All-Positions trigger across all asset slots simultaneously.
   */
  public setGlobalCloseAll(trigger: boolean): void {
    for (let i = 0; i < this.maxAssets; i++) {
      this.setCloseAllPositionsFlag(trigger, i);
    }
  }

  /**
   * Broadcasts atomic Engine-Pause state across all asset slots simultaneously.
   */
  public setGlobalPause(paused: boolean): void {
    for (let i = 0; i < this.maxAssets; i++) {
      this.setEnginePausedFlag(paused, i);
    }
  }

  /**
   * Broadcasts atomic Trigger-Recalibration state across all asset slots simultaneously.
   */
  public setGlobalRecalibration(trigger: boolean): void {
    for (let i = 0; i < this.maxAssets; i++) {
      this.setTriggerRecalibrationFlag(trigger, i);
    }
  }

  /**
   * Zero-fills all SharedArrayBuffer slots across all assets to flush memory telemetry state.
   */
  public flushTelemetry(): void {
    this.bigIntView.fill(0n);
    this.cvdTimestamps.fill(0);
    this.cvdValues.fill(0);
    this.cvdHeads.fill(0);
    this.cvdCounts.fill(0);
    this.lastCvdUpdateTs.fill(0);
    this.lastCvdRecorded.fill(0);
  }
}

