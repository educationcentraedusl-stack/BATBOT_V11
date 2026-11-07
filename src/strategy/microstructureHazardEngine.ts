/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * Microstructure Hazard Engine (OFI, TFI, VPIN & Cox Proportional Hazard Rate)
 *
 * Implements Cont-Kukanov-Stoikov Order Flow Imbalance (OFI), Trade Flow Imbalance (TFI),
 * Volume-Synchronized Probability of Toxicity (VPIN), and Cox Proportional Hazard Rate h(t).
 * Zero-GC circular buffer design for <1.5 microsecond execution latency.
 */

export interface MicrostructureMetrics {
  ofi: number;               // Cont-Kukanov-Stoikov rolling depth-normalized OFI [-1.0, 1.0]
  obi: number;               // Instantaneous L1 Order Book Imbalance: (Qbid-Qask)/(Qbid+Qask) [-1.0, 1.0]
  tfi: number;               // Trade Flow Imbalance [-1.0, 1.0]
  vpin: number;              // Volume-Synchronized Probability of Informed Trading [0.0, 1.0]
  hazardScore: number;       // Cox composite hazard score [0.0, 1.0]
  coxHazardRate: number;     // Continuous Cox Proportional Hazard Rate h(t)
  survivalProbability: number; // Position survival probability S(t) in [0.0, 1.0]
  isHazardExitTriggered: boolean;
  multiLevelOfi?: number;    // Phase 3: 5-level aggregated weighted OFI [-1.0, 1.0]
}

export class MicrostructureHazardEngine {
  private readonly symbol: string;

  // Circular Ring Buffers for Zero-GC
  private readonly ofiRingBuffer: Float64Array;
  private readonly depthRingBuffer: Float64Array;
  private ofiRingIdx: number = 0;
  private depthSampleCount: number = 0;
  private readonly ofiBufferSize: number;

  // Order Book Previous State (L1)
  private prevBidPx: number = 0;
  private prevBidQty: number = 0;
  private prevAskPx: number = 0;
  private prevAskQty: number = 0;
  private hasPrevBook: boolean = false;

  // Phase 3: 5-Level Aggregated OFI (Cont-Kukanov-Stoikov 2023 Extension) Zero-GC state
  public readonly DEPTH_LEVELS: number = 5;
  public readonly DEPTH_DECAY_LAMBDA: number = 0.5;
  private readonly prevBidPxLevels: Float64Array = new Float64Array(5);
  private readonly prevBidQtyLevels: Float64Array = new Float64Array(5);
  private readonly prevAskPxLevels: Float64Array = new Float64Array(5);
  private readonly prevAskQtyLevels: Float64Array = new Float64Array(5);
  private readonly depthWeights: Float64Array = new Float64Array(5);
  private hasPrevMultiLevelBook: boolean = false;
  private lastMultiLevelOfi: number = 0.0;

  // Trade Flow Imbalance Ring Buffers
  private readonly tradeBuyQtyRing: Float64Array;
  private readonly tradeSellQtyRing: Float64Array;
  private tradeRingIdx: number = 0;
  private readonly tradeBufferSize: number;

  // VPIN Bucket Aggregation State
  private readonly bucketVolume: number;
  private readonly vpinBucketRing: Float64Array;
  private vpinRingIdx: number = 0;
  private readonly vpinBucketCount: number;

  private currentBucketBuyVol: number = 0;
  private currentBucketSellVol: number = 0;
  private currentBucketTotalVol: number = 0;

  // Running sum accumulators for O(1) hot-path evaluation
  private runningSumOFI: number = 0;
  private runningSumDepth: number = 0;
  private runningSumBuy: number = 0;
  private runningSumSell: number = 0;
  private runningSumImbalance: number = 0;

  // Hazard Configuration Threshold
  private hazardThreshold: number;

  // Zero-GC Pre-allocated Cached Metrics Payload Ring Buffer
  private readonly cachedMetricsRing: MicrostructureMetrics[] = Array.from({ length: 8 }, () => ({
    ofi: 0,
    obi: 0,
    tfi: 0,
    vpin: 0,
    hazardScore: 0,
    coxHazardRate: 0,
    survivalProbability: 1.0,
    isHazardExitTriggered: false,
    multiLevelOfi: 0,
  }));
  private metricsRingIdx: number = 0;

  // Cox Proportional Hazard Parameters (theta weights)
  private static readonly THETA_OFI = 1.5;
  private static readonly THETA_TFI = 1.5;
  private static readonly THETA_VPIN = 2.0;
  private static readonly THETA_DECAY = 1.0;

  constructor(
    symbol: string,
    ofiBufferSize: number = 50,
    tradeBufferSize: number = 100,
    bucketVolume: number = 1.0,
    vpinBucketCount: number = 20,
    hazardThreshold: number = 0.75
  ) {
    this.symbol = symbol;
    this.ofiBufferSize = ofiBufferSize;
    this.ofiRingBuffer = new Float64Array(ofiBufferSize);
    this.depthRingBuffer = new Float64Array(ofiBufferSize);

    this.tradeBufferSize = tradeBufferSize;
    this.tradeBuyQtyRing = new Float64Array(tradeBufferSize);
    this.tradeSellQtyRing = new Float64Array(tradeBufferSize);

    this.bucketVolume = bucketVolume;
    this.vpinBucketCount = vpinBucketCount;
    this.vpinBucketRing = new Float64Array(vpinBucketCount);

    this.hazardThreshold = hazardThreshold;

    // Pre-compute exponential depth decay weights: w_l = e^(-0.5 * l)
    for (let l = 0; l < this.DEPTH_LEVELS; l++) {
      this.depthWeights[l] = Math.exp(-this.DEPTH_DECAY_LAMBDA * l);
    }
  }

  public reset(): void {
    this.ofiRingBuffer.fill(0);
    this.depthRingBuffer.fill(0);
    this.ofiRingIdx = 0;
    this.depthSampleCount = 0;
    this.runningSumOFI = 0;
    this.runningSumDepth = 0;
    this.prevBidPx = 0;
    this.prevBidQty = 0;
    this.prevAskPx = 0;
    this.prevAskQty = 0;
    this.hasPrevBook = false;
    this.tradeBuyQtyRing.fill(0);
    this.tradeSellQtyRing.fill(0);
    this.tradeRingIdx = 0;
    this.runningSumBuy = 0;
    this.runningSumSell = 0;
    this.vpinBucketRing.fill(0);
    this.vpinRingIdx = 0;
    this.runningSumImbalance = 0;
    this.currentBucketBuyVol = 0;
    this.currentBucketSellVol = 0;
    this.currentBucketTotalVol = 0;
    this.metricsRingIdx = 0;

    // Reset multi-level OFI state
    this.prevBidPxLevels.fill(0);
    this.prevBidQtyLevels.fill(0);
    this.prevAskPxLevels.fill(0);
    this.prevAskQtyLevels.fill(0);
    this.hasPrevMultiLevelBook = false;
    this.lastMultiLevelOfi = 0.0;
  }

  /**
   * Consumes live L2 Order Book snapshot / update and calculates Cont-Kukanov-Stoikov OFI
   */
  public updateOrderBook(bestBidPx: number, bestBidQty: number, bestAskPx: number, bestAskQty: number): number {
    if (!this.hasPrevBook) {
      this.prevBidPx = bestBidPx;
      this.prevBidQty = bestBidQty;
      this.prevAskPx = bestAskPx;
      this.prevAskQty = bestAskQty;
      this.hasPrevBook = true;
      return 0;
    }

    // Bid Order Flow (e_bid)
    let eBid = 0;
    if (bestBidPx > this.prevBidPx) {
      eBid = bestBidQty;
    } else if (bestBidPx === this.prevBidPx) {
      eBid = bestBidQty - this.prevBidQty;
    } else {
      eBid = -this.prevBidQty;
    }

    // Ask Order Flow (e_ask)
    let eAsk = 0;
    if (bestAskPx < this.prevAskPx) {
      eAsk = bestAskQty;
    } else if (bestAskPx === this.prevAskPx) {
      eAsk = bestAskQty - this.prevAskQty;
    } else {
      eAsk = -this.prevAskQty;
    }

    const instantOFI = eBid - eAsk;
    const instantDepth = (bestBidQty + bestAskQty) * 0.5;

    // Zero-GC insertion into circular ring buffers with O(1) running sums
    const oldOFI = this.ofiRingBuffer[this.ofiRingIdx];
    const oldDepth = this.depthRingBuffer[this.ofiRingIdx];
    this.ofiRingBuffer[this.ofiRingIdx] = instantOFI;
    this.depthRingBuffer[this.ofiRingIdx] = instantDepth;
    this.runningSumOFI += instantOFI - oldOFI;
    this.runningSumDepth += instantDepth - oldDepth;

    this.ofiRingIdx = (this.ofiRingIdx + 1) % this.ofiBufferSize;
    if (this.depthSampleCount < this.ofiBufferSize) {
      this.depthSampleCount++;
    }

    // Update previous book state
    this.prevBidPx = bestBidPx;
    this.prevBidQty = bestBidQty;
    this.prevAskPx = bestAskPx;
    this.prevAskQty = bestAskQty;

    return instantOFI;
  }

  /**
   * Consumes real-time aggressive trade execution tick
   */
  public updateTrade(price: number, qty: number, isBuyerMaker: boolean): void {
    const buyQty = isBuyerMaker ? 0 : qty;  // Taker Buy
    const sellQty = isBuyerMaker ? qty : 0; // Taker Sell

    // 1. Update Trade Flow Imbalance Ring Buffer with O(1) running sums
    const oldBuy = this.tradeBuyQtyRing[this.tradeRingIdx];
    const oldSell = this.tradeSellQtyRing[this.tradeRingIdx];
    this.tradeBuyQtyRing[this.tradeRingIdx] = buyQty;
    this.tradeSellQtyRing[this.tradeRingIdx] = sellQty;
    this.runningSumBuy += buyQty - oldBuy;
    this.runningSumSell += sellQty - oldSell;
    this.tradeRingIdx = (this.tradeRingIdx + 1) % this.tradeBufferSize;

    // 2. Accumulate VPIN Volume Buckets
    let remainingQty = qty;
    while (remainingQty > 0) {
      const spaceInBucket = this.bucketVolume - this.currentBucketTotalVol;
      const fillAmount = Math.min(remainingQty, spaceInBucket);

      if (isBuyerMaker) {
        this.currentBucketSellVol += fillAmount;
      } else {
        this.currentBucketBuyVol += fillAmount;
      }

      this.currentBucketTotalVol += fillAmount;
      remainingQty -= fillAmount;

      if (this.currentBucketTotalVol >= this.bucketVolume) {
        const bucketImbalance = Math.abs(this.currentBucketBuyVol - this.currentBucketSellVol);
        const oldBucket = this.vpinBucketRing[this.vpinRingIdx];
        this.vpinBucketRing[this.vpinRingIdx] = bucketImbalance;
        this.runningSumImbalance += bucketImbalance - oldBucket;
        this.vpinRingIdx = (this.vpinRingIdx + 1) % this.vpinBucketCount;

        // Reset current bucket state
        this.currentBucketBuyVol = 0;
        this.currentBucketSellVol = 0;
        this.currentBucketTotalVol = 0;
      }
    }
  }

  /**
   * Calculates normalized Order Flow Imbalance (OFI) [-1.0, 1.0] in O(1) using running sums.
   */
  public getNormalizedOFI(): number {
    const samples = Math.min(this.ofiBufferSize, Math.max(1, this.depthSampleCount));
    const avgDepth = this.runningSumDepth / samples;
    if (avgDepth <= 0) return 0;

    const rawNorm = this.runningSumOFI / (avgDepth * samples);
    return Math.max(-1.0, Math.min(1.0, rawNorm));
  }

  /**
   * Calculates Trade Flow Imbalance (TFI) [-1.0, 1.0] in O(1) using running sums.
   */
  public getTFI(): number {
    const totalVol = this.runningSumBuy + this.runningSumSell;
    if (totalVol <= 0) return 0;

    return (this.runningSumBuy - this.runningSumSell) / totalVol;
  }

  /**
   * Calculates Volume-Synchronized Probability of Toxicity (VPIN) [0.0, 1.0] in O(1) using running sums.
   */
  public getVPIN(): number {
    const maxCapacity = this.vpinBucketCount * this.bucketVolume;
    if (maxCapacity <= 0) return 0;

    return Math.max(0.0, Math.min(1.0, this.runningSumImbalance / maxCapacity));
  }

  /**
   * Fast zero-GC evaluation of Cox Proportional Hazard rate h(t) = h0(t) * exp(theta^T * X_t)
   * and Survival Probability S(t) = exp(-H(t)) using pre-allocated cached object ring pool.
   */
  public getHazardMetrics(
    positionSide: "LONG" | "SHORT",
    currentLogitConfidence: number = 0.50,
    durationMs: number = 0
  ): MicrostructureMetrics {
    const ofi = this.getNormalizedOFI();
    const tfi = this.getTFI();
    const vpin = this.getVPIN();

    // Instantaneous L1 Order Book Imbalance (OBI): (Q_bid - Q_ask) / (Q_bid + Q_ask)
    // Uses current live resting depth at the best bid/ask — the correct Stoikov Micro-Price input.
    // Distinct from rolling OFI which measures order flow pressure over time.
    const bidDepth = this.prevBidQty;
    const askDepth = this.prevAskQty;
    const totalDepth = bidDepth + askDepth;
    const obi = totalDepth > 0
      ? Math.max(-1.0, Math.min(1.0, (bidDepth - askDepth) / totalDepth))
      : 0;

    let adverseOFI = 0;
    let adverseTFI = 0;

    if (positionSide === "LONG") {
      if (ofi < 0) adverseOFI = -ofi;
      if (tfi < 0) adverseTFI = -tfi;
    } else {
      if (ofi > 0) adverseOFI = ofi;
      if (tfi > 0) adverseTFI = tfi;
    }

    const confidenceDecay = currentLogitConfidence < 0.50 ? (0.50 - currentLogitConfidence) * 2.0 : 0;

    // Composite Linear Risk Score (uses OFI for dynamic flow pressure — correct for Cox hazard)
    const hazardScore = Math.min(
      1.0,
      0.35 * adverseOFI + 0.35 * adverseTFI + 0.20 * vpin + 0.10 * confidenceDecay
    );

    // Fixed Weibull Baseline Hazard h0(t): prevents artificial time-decay panic flushes
    const tSec = Math.max(0.1, durationMs * 0.001);
    const h0_t = 0.002 * Math.pow(1.0 + 0.01 * tSec, 0.1);

    // Linear Predictor eta = theta^T * X_t
    const eta = 1.5 * adverseOFI + 1.5 * adverseTFI + 2.0 * vpin + 1.0 * confidenceDecay;

    // Cox Proportional Hazard Rate h(t) = h0(t) * exp(eta)
    const coxHazardRate = h0_t * Math.exp(eta);

    // Bounded Cumulative Hazard H(t): prevents time duration alone from triggering panic flushes without toxic flow
    const durationFactor = Math.min(10.0, 1.0 + 0.05 * tSec);
    const cumulativeHazard = coxHazardRate * durationFactor;
    const survivalProbability = Math.max(0.001, Math.min(1.0, Math.exp(-cumulativeHazard)));

    // SOTA August 2026: De-noised Toxic Cascade Detection
    // Hazard Flush ONLY triggers on sustained high toxic order flow (hazardScore >= 0.85) or catastrophic survival collapse
    const isHazardExitTriggered = hazardScore >= Math.max(0.85, this.hazardThreshold) || (survivalProbability <= 0.05 && hazardScore >= 0.65);

    const res = this.cachedMetricsRing[this.metricsRingIdx];
    this.metricsRingIdx = (this.metricsRingIdx + 1) % 8;

    res.ofi = ofi;
    res.obi = obi;
    res.tfi = tfi;
    res.vpin = vpin;
    res.hazardScore = hazardScore;
    res.coxHazardRate = coxHazardRate;
    res.survivalProbability = survivalProbability;
    res.isHazardExitTriggered = isHazardExitTriggered;
    res.multiLevelOfi = this.lastMultiLevelOfi;

    return res;
  }

  public setHazardThreshold(threshold: number): void {
    this.hazardThreshold = Math.max(0.1, Math.min(0.99, threshold));
  }

  public getSymbol(): string {
    return this.symbol;
  }

  public getDepthWeights(): Float64Array {
    return this.depthWeights;
  }

  public getPrevBidPxLevels(): Float64Array {
    return this.prevBidPxLevels;
  }

  public getPrevBidQtyLevels(): Float64Array {
    return this.prevBidQtyLevels;
  }

  public getPrevAskPxLevels(): Float64Array {
    return this.prevAskPxLevels;
  }

  public getPrevAskQtyLevels(): Float64Array {
    return this.prevAskQtyLevels;
  }

  public hasMultiLevelHistory(): boolean {
    return this.hasPrevMultiLevelBook;
  }

  public getLastMultiLevelOfi(): number {
    return this.lastMultiLevelOfi;
  }

  /**
   * Phase 3: 5-Level Aggregated Order Flow Imbalance (OFI) based on Cont-Kukanov-Stoikov (2023).
   *
   * Evaluates order flow imbalance across top-5 order book depth levels weighted by exponential
   * depth decay weights w_l = e^(-0.5 * l) for l in [0..4].
   *
   * Mathematical Model:
   *   OFI^(5) = ( sum_{l=0..4} w_l * ( dQ_bid^(l) - dQ_ask^(l) ) / meanDepth_l ) / sum_{l=0..4} w_l
   *
   * Where per-level delta Q:
   *   dQ_bid^(l) = +Q_b(t) if P_b(t) > P_b(t-1)
   *                Q_b(t) - Q_b(t-1) if P_b(t) == P_b(t-1)
   *                -Q_b(t-1) if P_b(t) < P_b(t-1)
   *   dQ_ask^(l) = +Q_a(t) if P_a(t) < P_a(t-1)
   *                Q_a(t) - Q_a(t-1) if P_a(t) == P_a(t-1)
   *                -Q_a(t-1) if P_a(t) > P_a(t-1)
   *
   * ZERO-GC HOT-PATH GUARANTEE:
   * Absolutely NO `new` keywords, NO `.map()`, NO `.reduce()`, NO closures, and NO array literal allocations `[]`.
   * Mutates and reads pre-allocated class Float64Array properties strictly in-place.
   */
  public computeMultiLevelOfi(
    bidLevels: Array<{ price: number; qty: number }>,
    askLevels: Array<{ price: number; qty: number }>,
    rollingMeanDepths?: Float64Array
  ): number;
  public computeMultiLevelOfi(
    bidPxLevels: Float64Array,
    bidQtyLevels: Float64Array,
    askPxLevels: Float64Array,
    askQtyLevels: Float64Array,
    rollingMeanDepths?: Float64Array
  ): number;
  public computeMultiLevelOfi(
    arg0: Float64Array | Array<{ price: number; qty: number }>,
    arg1: Float64Array | Array<{ price: number; qty: number }>,
    arg2?: Float64Array,
    arg3?: Float64Array,
    arg4?: Float64Array
  ): number {
    let ofiSum = 0.0;
    let weightSum = 0.0;

    if (arg0 instanceof Float64Array && arg1 instanceof Float64Array && arg2 instanceof Float64Array && arg3 instanceof Float64Array) {
      // Primary Zero-GC Hot-Path: Direct Float64Array views (0 heap allocations)
      const bidPx = arg0;
      const bidQty = arg1;
      const askPx = arg2;
      const askQty = arg3;
      const rollingMeanDepths = arg4;

      const numLevels = Math.min(this.DEPTH_LEVELS, bidPx.length, bidQty.length, askPx.length, askQty.length);

      // Cold start: record initial levels and return neutral OFI 0.0
      if (!this.hasPrevMultiLevelBook) {
        for (let l = 0; l < numLevels; l++) {
          const bp = Number.isFinite(bidPx[l]) ? bidPx[l] : 0.0;
          const bq = Number.isFinite(bidQty[l]) && bidQty[l] > 0 ? bidQty[l] : 0.0;
          const ap = Number.isFinite(askPx[l]) ? askPx[l] : 0.0;
          const aq = Number.isFinite(askQty[l]) && askQty[l] > 0 ? askQty[l] : 0.0;

          this.prevBidPxLevels[l] = bp;
          this.prevBidQtyLevels[l] = bq;
          this.prevAskPxLevels[l] = ap;
          this.prevAskQtyLevels[l] = aq;
        }
        this.hasPrevMultiLevelBook = true;
        this.lastMultiLevelOfi = 0.0;
        return 0.0;
      }

      for (let l = 0; l < numLevels; l++) {
        const bp = Number.isFinite(bidPx[l]) ? bidPx[l] : 0.0;
        const bq = Number.isFinite(bidQty[l]) && bidQty[l] > 0 ? bidQty[l] : 0.0;
        const ap = Number.isFinite(askPx[l]) ? askPx[l] : 0.0;
        const aq = Number.isFinite(askQty[l]) && askQty[l] > 0 ? askQty[l] : 0.0;

        const prevBp = this.prevBidPxLevels[l];
        const prevBq = this.prevBidQtyLevels[l];
        const prevAp = this.prevAskPxLevels[l];
        const prevAq = this.prevAskQtyLevels[l];

        // Skip level if neither current nor previous book had any depth
        if (bp <= 0 && bq <= 0 && prevBp <= 0 && prevBq <= 0 &&
            ap <= 0 && aq <= 0 && prevAp <= 0 && prevAq <= 0) {
          continue;
        }

        // 1. Bid Order Flow: dQ_bid^(l)
        let dQbid = 0.0;
        if (bp <= 0) {
          dQbid = -prevBq; // Level vanished
        } else if (prevBp <= 0) {
          dQbid = bq; // New level appeared
        } else if (bp > prevBp) {
          dQbid = bq; // Bid price improved (aggressive liquidity addition)
        } else if (bp === prevBp) {
          dQbid = bq - prevBq; // Bid price unchanged (depth delta)
        } else {
          dQbid = -prevBq; // Bid price worsened (liquidity removed/walked)
        }

        // 2. Ask Order Flow: dQ_ask^(l)
        let dQask = 0.0;
        if (ap <= 0) {
          dQask = -prevAq; // Level vanished
        } else if (prevAp <= 0) {
          dQask = aq; // New level appeared
        } else if (ap < prevAp) {
          dQask = aq; // Ask price improved (lower ask = aggressive addition)
        } else if (ap === prevAp) {
          dQask = aq - prevAq; // Ask price unchanged (depth delta)
        } else {
          dQask = -prevAq; // Ask price worsened (higher ask = liquidity removed/walked)
        }

        // 3. Denominator Normalization: rollingMeanDepths[l] if valid & > 0, else instant depth
        let meanDepth = 1.0;
        if (rollingMeanDepths && l < rollingMeanDepths.length && Number.isFinite(rollingMeanDepths[l]) && rollingMeanDepths[l] > 0) {
          meanDepth = rollingMeanDepths[l];
        } else {
          const instantDepth = (bq + aq) * 0.5;
          if (instantDepth > 0) {
            meanDepth = instantDepth;
          } else {
            const prevDepth = (prevBq + prevAq) * 0.5;
            meanDepth = prevDepth > 0 ? prevDepth : 1.0;
          }
        }
        if (!Number.isFinite(meanDepth) || meanDepth <= 0) {
          meanDepth = 1.0;
        }

        const w = this.depthWeights[l];
        ofiSum += w * ((dQbid - dQask) / meanDepth);
        weightSum += w;

        // In-place mutation of previous state for next tick (Zero-GC)
        this.prevBidPxLevels[l] = bp;
        this.prevBidQtyLevels[l] = bq;
        this.prevAskPxLevels[l] = ap;
        this.prevAskQtyLevels[l] = aq;
      }
    } else {
      // Architecture Report Compatibility Path: Array<{ price: number; qty: number }>
      const bidLevels = arg0 as Array<{ price: number; qty: number }>;
      const askLevels = arg1 as Array<{ price: number; qty: number }>;
      const rollingMeanDepths = arg2;

      const numLevels = Math.min(this.DEPTH_LEVELS, bidLevels.length, askLevels.length);

      if (!this.hasPrevMultiLevelBook) {
        for (let l = 0; l < numLevels; l++) {
          const b = bidLevels[l];
          const a = askLevels[l];
          const bp = b && Number.isFinite(b.price) ? b.price : 0.0;
          const bq = b && Number.isFinite(b.qty) && b.qty > 0 ? b.qty : 0.0;
          const ap = a && Number.isFinite(a.price) ? a.price : 0.0;
          const aq = a && Number.isFinite(a.qty) && a.qty > 0 ? a.qty : 0.0;

          this.prevBidPxLevels[l] = bp;
          this.prevBidQtyLevels[l] = bq;
          this.prevAskPxLevels[l] = ap;
          this.prevAskQtyLevels[l] = aq;
        }
        this.hasPrevMultiLevelBook = true;
        this.lastMultiLevelOfi = 0.0;
        return 0.0;
      }

      for (let l = 0; l < numLevels; l++) {
        const b = bidLevels[l];
        const a = askLevels[l];
        const bp = b && Number.isFinite(b.price) ? b.price : 0.0;
        const bq = b && Number.isFinite(b.qty) && b.qty > 0 ? b.qty : 0.0;
        const ap = a && Number.isFinite(a.price) ? a.price : 0.0;
        const aq = a && Number.isFinite(a.qty) && a.qty > 0 ? a.qty : 0.0;

        const prevBp = this.prevBidPxLevels[l];
        const prevBq = this.prevBidQtyLevels[l];
        const prevAp = this.prevAskPxLevels[l];
        const prevAq = this.prevAskQtyLevels[l];

        if (bp <= 0 && bq <= 0 && prevBp <= 0 && prevBq <= 0 &&
            ap <= 0 && aq <= 0 && prevAp <= 0 && prevAq <= 0) {
          continue;
        }

        let dQbid = 0.0;
        if (bp <= 0) {
          dQbid = -prevBq;
        } else if (prevBp <= 0) {
          dQbid = bq;
        } else if (bp > prevBp) {
          dQbid = bq;
        } else if (bp === prevBp) {
          dQbid = bq - prevBq;
        } else {
          dQbid = -prevBq;
        }

        let dQask = 0.0;
        if (ap <= 0) {
          dQask = -prevAq;
        } else if (prevAp <= 0) {
          dQask = aq;
        } else if (ap < prevAp) {
          dQask = aq;
        } else if (ap === prevAp) {
          dQask = aq - prevAq;
        } else {
          dQask = -prevAq;
        }

        let meanDepth = 1.0;
        if (rollingMeanDepths && l < rollingMeanDepths.length && Number.isFinite(rollingMeanDepths[l]) && rollingMeanDepths[l] > 0) {
          meanDepth = rollingMeanDepths[l];
        } else {
          const instantDepth = (bq + aq) * 0.5;
          if (instantDepth > 0) {
            meanDepth = instantDepth;
          } else {
            const prevDepth = (prevBq + prevAq) * 0.5;
            meanDepth = prevDepth > 0 ? prevDepth : 1.0;
          }
        }
        if (!Number.isFinite(meanDepth) || meanDepth <= 0) {
          meanDepth = 1.0;
        }

        const w = this.depthWeights[l];
        ofiSum += w * ((dQbid - dQask) / meanDepth);
        weightSum += w;

        this.prevBidPxLevels[l] = bp;
        this.prevBidQtyLevels[l] = bq;
        this.prevAskPxLevels[l] = ap;
        this.prevAskQtyLevels[l] = aq;
      }
    }

    const rawResult = weightSum > 0 ? ofiSum / weightSum : 0.0;
    const finalOfi = Number.isFinite(rawResult) ? Math.max(-1.0, Math.min(1.0, rawResult)) : 0.0;
    this.lastMultiLevelOfi = finalOfi;
    return finalOfi;
  }
}
