/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING ENGINE
 * Microstructure Hazard Engine (OFI, TFI, VPIN & Cox Proportional Hazard Rate)
 *
 * Implements Cont-Kukanov-Stoikov Order Flow Imbalance (OFI), Trade Flow Imbalance (TFI),
 * Volume-Synchronized Probability of Toxicity (VPIN), and Cox Proportional Hazard Rate h(t).
 * Zero-GC circular buffer design for <1.5 microsecond execution latency.
 */

export interface MicrostructureMetrics {
  ofi: number;               // Normalized [-1.0, 1.0]
  tfi: number;               // Normalized [-1.0, 1.0]
  vpin: number;              // Scaled [0.0, 1.0]
  hazardScore: number;       // Scaled [0.0, 1.0]
  coxHazardRate: number;     // Continuous Cox Proportional Hazard Rate h(t)
  survivalProbability: number; // Position survival probability S(t) in [0.0, 1.0]
  isHazardExitTriggered: boolean;
}

export class MicrostructureHazardEngine {
  private readonly symbol: string;

  // Circular Ring Buffers for Zero-GC
  private readonly ofiRingBuffer: Float64Array;
  private ofiRingIdx: number = 0;
  private readonly ofiBufferSize: number;

  // Order Book Previous State
  private prevBidPx: number = 0;
  private prevBidQty: number = 0;
  private prevAskPx: number = 0;
  private prevAskQty: number = 0;
  private hasPrevBook: boolean = false;

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

  // Hazard Configuration Threshold
  private hazardThreshold: number;

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

    this.tradeBufferSize = tradeBufferSize;
    this.tradeBuyQtyRing = new Float64Array(tradeBufferSize);
    this.tradeSellQtyRing = new Float64Array(tradeBufferSize);

    this.bucketVolume = bucketVolume;
    this.vpinBucketCount = vpinBucketCount;
    this.vpinBucketRing = new Float64Array(vpinBucketCount);

    this.hazardThreshold = hazardThreshold;
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

    // Zero-GC insertion into circular ring buffer
    this.ofiRingBuffer[this.ofiRingIdx] = instantOFI;
    this.ofiRingIdx = (this.ofiRingIdx + 1) % this.ofiBufferSize;

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

    // 1. Update Trade Flow Imbalance Ring Buffer
    this.tradeBuyQtyRing[this.tradeRingIdx] = buyQty;
    this.tradeSellQtyRing[this.tradeRingIdx] = sellQty;
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
        this.vpinBucketRing[this.vpinRingIdx] = bucketImbalance;
        this.vpinRingIdx = (this.vpinRingIdx + 1) % this.vpinBucketCount;

        // Reset current bucket state
        this.currentBucketBuyVol = 0;
        this.currentBucketSellVol = 0;
        this.currentBucketTotalVol = 0;
      }
    }
  }

  /**
   * Calculates normalized Order Flow Imbalance (OFI) [-1.0, 1.0]
   */
  public getNormalizedOFI(): number {
    let sumOFI = 0;
    for (let i = 0; i < this.ofiBufferSize; i++) {
      sumOFI += this.ofiRingBuffer[i];
    }
    const depthScale = (this.prevBidQty + this.prevAskQty) * 0.5;
    if (depthScale <= 0) return 0;

    const rawNorm = sumOFI / (depthScale * (this.ofiBufferSize * 0.2));
    return Math.max(-1.0, Math.min(1.0, rawNorm));
  }

  /**
   * Calculates Trade Flow Imbalance (TFI) [-1.0, 1.0]
   */
  public getTFI(): number {
    let sumBuy = 0;
    let sumSell = 0;
    for (let i = 0; i < this.tradeBufferSize; i++) {
      sumBuy += this.tradeBuyQtyRing[i];
      sumSell += this.tradeSellQtyRing[i];
    }

    const totalVol = sumBuy + sumSell;
    if (totalVol <= 0) return 0;

    return (sumBuy - sumSell) / totalVol;
  }

  /**
   * Calculates Volume-Synchronized Probability of Toxicity (VPIN) [0.0, 1.0]
   */
  public getVPIN(): number {
    let sumImbalance = 0;
    for (let i = 0; i < this.vpinBucketCount; i++) {
      sumImbalance += this.vpinBucketRing[i];
    }
    const maxCapacity = this.vpinBucketCount * this.bucketVolume;
    if (maxCapacity <= 0) return 0;

    return Math.max(0.0, Math.min(1.0, sumImbalance / maxCapacity));
  }

  /**
   * Fast evaluation of Cox Proportional Hazard rate h(t) = h0(t) * exp(theta^T * X_t)
   * and Survival Probability S(t) = exp(-H(t))
   */
  public getHazardMetrics(
    positionSide: "LONG" | "SHORT",
    currentLogitConfidence: number = 0.50,
    durationMs: number = 0
  ): MicrostructureMetrics {
    const ofi = this.getNormalizedOFI();
    const tfi = this.getTFI();
    const vpin = this.getVPIN();

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

    // Composite Linear Risk Score
    const hazardScore = Math.min(
      1.0,
      0.35 * adverseOFI + 0.35 * adverseTFI + 0.20 * vpin + 0.10 * confidenceDecay
    );

    // Weibull Baseline Hazard h0(t)
    const tSec = Math.max(0.1, durationMs * 0.001);
    const h0_t = 0.06 * Math.pow(0.05 * tSec, 0.2);

    // Linear Predictor eta = theta^T * X_t
    const eta = 1.5 * adverseOFI + 1.5 * adverseTFI + 2.0 * vpin + 1.0 * confidenceDecay;

    // Cox Proportional Hazard Rate h(t) = h0(t) * exp(eta)
    const coxHazardRate = h0_t * Math.exp(eta);

    // Cumulative Hazard H(t) = h(t) * tSec
    const cumulativeHazard = coxHazardRate * tSec;
    const survivalProbability = Math.max(0.001, Math.min(1.0, Math.exp(-cumulativeHazard)));

    const isHazardExitTriggered = hazardScore >= this.hazardThreshold || survivalProbability <= 0.15;

    return {
      ofi,
      tfi,
      vpin,
      hazardScore,
      coxHazardRate,
      survivalProbability,
      isHazardExitTriggered
    };
  }

  public setHazardThreshold(threshold: number): void {
    this.hazardThreshold = Math.max(0.1, Math.min(0.99, threshold));
  }

  public getSymbol(): string {
    return this.symbol;
  }
}
