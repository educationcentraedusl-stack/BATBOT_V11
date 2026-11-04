/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * VEGAM Phase 6: Adversarial Exit Gate (Layer 4 Defensive Shield)
 *
 * Implements Layer 4 (Adversarial Order Flow Emergency Exit Gate) per
 * the VEGAM Master Implementation Plan (2026 SOTA Exit Architecture).
 *
 * Core Functionality:
 * Evaluates real-time microstructural order flow toxicity, rapid mid-price drift,
 * and multi-signal consensus. When >= adversarialMinSignals (default: 2) independent
 * anomaly signals fire simultaneously concurrently with an adverse price velocity shock
 * exceeding the dynamic ATR threshold, triggers an immediate aggressive market exit:
 * executionStyle = "AGGRESSIVE_MARKET"
 * reason = "ADVERSARIAL_CASCADE_EXIT_${slot.side}"
 *
 * Zero-GC Invariant:
 * Pre-allocated singleton and circular result payload ring buffer ensuring < 0.5 µs latency.
 */

import { MicrostructureMetrics } from "./microstructureHazardEngine";
import { PositionSlot } from "./positionLedger";

export interface AdversarialExitConfig {
  /** Minimum number of independent adverse anomaly signals required for consensus (default: 2) */
  adversarialMinSignals: number;
  /** VPIN floor above which flow is considered toxic (default: 0.65) */
  vpinToxicFloor: number;
  /** Hawkes intensity threshold for high order arrival bursts (default: 1.80) */
  hawkesExpansionThreshold: number;
  /** Order Book Imbalance adverse threshold below which depth is hostile (default: -0.20) */
  obiTightenThreshold: number;
  /** Order Book Imbalance supportive threshold (default: 0.20) */
  obiExpandThreshold: number;
  /** Dynamic ATR multiplier for adverse price velocity threshold (default: 1.25) */
  atrVelocityMultiplier: number;
  /** Minimum holding time in seconds before gate activates (default: 0.0) */
  minHoldingSeconds: number;
  /** LOB entropy threshold indicating depth collapse (default: 2.80) */
  entropyAnomalyThreshold: number;
  /** OFI threshold indicating aggressive flow against trade (default: -0.40) */
  ofiAdverseThreshold: number;
}

export const DEFAULT_ADVERSARIAL_CONFIG: Readonly<AdversarialExitConfig> = Object.freeze({
  adversarialMinSignals: 2,
  vpinToxicFloor: 0.65,
  hawkesExpansionThreshold: 1.80,
  obiTightenThreshold: -0.20,
  obiExpandThreshold: 0.20,
  atrVelocityMultiplier: 1.25,
  minHoldingSeconds: 0.0,
  entropyAnomalyThreshold: 2.80,
  ofiAdverseThreshold: -0.40,
});

export interface AdversarialExitSignals {
  obiReversal: boolean;
  toxicVpin: boolean;
  adverseFlow: boolean;
  hawkesBurst: boolean;
  adverseSweep: boolean;
  entropyCollapse: boolean;
  priceVelocityShock: boolean;
}

export interface AdversarialExitResult {
  isBreached: boolean;
  activeSignalCount: number;
  signals: AdversarialExitSignals;
  adverseVelocity: number;
  thresholdVelocity: number;
  reason: string;
}

export class AdversarialExitGate {
  private readonly config: AdversarialExitConfig;

  // Zero-GC Pre-allocated Cached Result Payload Ring Buffer (8 slots)
  private readonly resultRing: AdversarialExitResult[] = Array.from({ length: 8 }, () => ({
    isBreached: false,
    activeSignalCount: 0,
    signals: {
      obiReversal: false,
      toxicVpin: false,
      adverseFlow: false,
      hawkesBurst: false,
      adverseSweep: false,
      entropyCollapse: false,
      priceVelocityShock: false,
    },
    adverseVelocity: 0,
    thresholdVelocity: 0,
    reason: "",
  }));
  private ringIdx: number = 0;

  // Pre-allocated static singleton for zero-GC static evaluation
  private static readonly STATIC_RESULT: AdversarialExitResult = {
    isBreached: false,
    activeSignalCount: 0,
    signals: {
      obiReversal: false,
      toxicVpin: false,
      adverseFlow: false,
      hawkesBurst: false,
      adverseSweep: false,
      entropyCollapse: false,
      priceVelocityShock: false,
    },
    adverseVelocity: 0,
    thresholdVelocity: 0,
    reason: "",
  };

  constructor(config?: Partial<AdversarialExitConfig>) {
    this.config = config ? { ...DEFAULT_ADVERSARIAL_CONFIG, ...config } : { ...DEFAULT_ADVERSARIAL_CONFIG };
  }

  public getConfig(): Readonly<AdversarialExitConfig> {
    return this.config;
  }

  /**
   * Evaluates the Adversarial Exit Gate on an occupied position slot.
   * Hot-path zero heap allocation execution (< 0.5 µs latency).
   */
  public evaluate(
    slot: PositionSlot,
    markPrice: number,
    hazardMetrics: MicrostructureMetrics | undefined,
    gkAtrComposite?: number,
    hawkesIntensity?: number,
    isSweepDetected?: boolean,
    lobEntropy?: number,
    nowMs: number = 0
  ): AdversarialExitResult {
    const out = this.resultRing[this.ringIdx];
    this.ringIdx = (this.ringIdx + 1) & 7;

    return AdversarialExitGate.evaluateInternal(
      slot,
      markPrice,
      hazardMetrics,
      gkAtrComposite,
      hawkesIntensity,
      isSweepDetected,
      lobEntropy,
      nowMs,
      this.config,
      out
    );
  }

  /**
   * Static evaluation using pre-allocated singleton
   */
  public static evaluate(
    slot: PositionSlot,
    markPrice: number,
    hazardMetrics: MicrostructureMetrics | undefined,
    gkAtrComposite?: number,
    hawkesIntensity?: number,
    isSweepDetected?: boolean,
    lobEntropy?: number,
    nowMs: number = 0,
    config?: AdversarialExitConfig
  ): AdversarialExitResult {
    return AdversarialExitGate.evaluateInternal(
      slot,
      markPrice,
      hazardMetrics,
      gkAtrComposite,
      hawkesIntensity,
      isSweepDetected,
      lobEntropy,
      nowMs,
      config ?? DEFAULT_ADVERSARIAL_CONFIG,
      AdversarialExitGate.STATIC_RESULT
    );
  }

  private static evaluateInternal(
    slot: PositionSlot,
    markPrice: number,
    hazardMetrics: MicrostructureMetrics | undefined,
    gkAtrComposite: number | undefined,
    hawkesIntensity: number | undefined,
    isSweepDetected: boolean | undefined,
    lobEntropy: number | undefined,
    nowMs: number,
    cfg: AdversarialExitConfig,
    out: AdversarialExitResult
  ): AdversarialExitResult {
    // Reset output struct
    out.isBreached = false;
    out.activeSignalCount = 0;
    out.signals.obiReversal = false;
    out.signals.toxicVpin = false;
    out.signals.adverseFlow = false;
    out.signals.hawkesBurst = false;
    out.signals.adverseSweep = false;
    out.signals.entropyCollapse = false;
    out.signals.priceVelocityShock = false;
    out.adverseVelocity = 0;
    out.thresholdVelocity = 0;
    out.reason = "";

    if (!slot.isOccupied || slot.quantity <= 0 || slot.entryPrice <= 0 || markPrice <= 0) {
      return out;
    }

    if (cfg.minHoldingSeconds > 0) {
      const openTime = (slot.originalOpenTime && slot.originalOpenTime > 0)
        ? slot.originalOpenTime
        : (slot.openTime && slot.openTime > 0 ? slot.openTime : nowMs);
      const effectiveNow = nowMs > 0 ? nowMs : Date.now();
      const durationSec = Math.max(0, (effectiveNow - openTime) / 1000);
      if (durationSec < cfg.minHoldingSeconds) {
        return out;
      }
    }

    const isLong = slot.side === "LONG";
    const safeAtr = (typeof gkAtrComposite === "number" && Number.isFinite(gkAtrComposite) && gkAtrComposite > 0)
      ? gkAtrComposite
      : 0.00906;

    // -------------------------------------------------------------------------
    // 1. Adverse Price Velocity Shock Evaluation
    // Measures price divergence against position entry / peak
    // -------------------------------------------------------------------------
    const adversePriceMove = isLong ? (slot.entryPrice - markPrice) : (markPrice - slot.entryPrice);
    const adverseMovePct = (adversePriceMove / slot.entryPrice);
    const thresholdVelocity = cfg.atrVelocityMultiplier * safeAtr;

    out.adverseVelocity = adverseMovePct;
    out.thresholdVelocity = thresholdVelocity;

    const isPriceShock = adverseMovePct >= thresholdVelocity;
    out.signals.priceVelocityShock = isPriceShock;

    // -------------------------------------------------------------------------
    // 2. Microstructure Toxicity & Reversal Signals
    // -------------------------------------------------------------------------
    const liveObi = hazardMetrics && Number.isFinite(hazardMetrics.obi) ? hazardMetrics.obi : 0.0;
    const liveVpin = hazardMetrics && Number.isFinite(hazardMetrics.vpin) ? hazardMetrics.vpin : 0.0;
    const liveOfi = hazardMetrics && Number.isFinite(hazardMetrics.ofi) ? hazardMetrics.ofi : 0.0;
    const liveTfi = hazardMetrics && Number.isFinite(hazardMetrics.tfi) ? hazardMetrics.tfi : 0.0;
    const liveHawkes = typeof hawkesIntensity === "number" && Number.isFinite(hawkesIntensity) ? hawkesIntensity : 1.0;
    const liveSweep = Boolean(isSweepDetected);
    const liveEntropy = typeof lobEntropy === "number" && Number.isFinite(lobEntropy) ? lobEntropy : 1.0;

    // Signal A: Directional OBI Reversal (Book depth pressure aggressively against position)
    const isObiReversed = isLong
      ? (liveObi < cfg.obiTightenThreshold)
      : (liveObi > cfg.obiExpandThreshold);
    out.signals.obiReversal = isObiReversed;

    // Signal B: Toxic Order Flow / Informed Trading Spike (VPIN >= 0.65)
    const isToxicVpin = liveVpin >= cfg.vpinToxicFloor;
    out.signals.toxicVpin = isToxicVpin;

    // Signal C: Adverse Flow Imbalance (OFI / TFI order flow delta against position)
    const isAdverseFlow = isLong
      ? (liveOfi < cfg.ofiAdverseThreshold || liveTfi < cfg.ofiAdverseThreshold)
      : (liveOfi > -cfg.ofiAdverseThreshold || liveTfi > -cfg.ofiAdverseThreshold);
    out.signals.adverseFlow = isAdverseFlow;

    // Signal D: Hawkes Intensity Burst (High order arrival frequency concurrent with adverse book pressure)
    const isHawkesBurst = liveHawkes >= cfg.hawkesExpansionThreshold && (isLong ? liveObi < 0 : liveObi > 0);
    out.signals.hawkesBurst = isHawkesBurst;

    // Signal E: Adverse Liquidity Sweep (Aggressive order sweep against position)
    const isAdverseSweep = liveSweep && (isLong ? (liveObi < 0 || markPrice < slot.entryPrice) : (liveObi > 0 || markPrice > slot.entryPrice));
    out.signals.adverseSweep = isAdverseSweep;

    // Signal F: Limit Order Book Entropy Collapse (Book dispersion breakdown)
    const isEntropyCollapse = liveEntropy >= cfg.entropyAnomalyThreshold;
    out.signals.entropyCollapse = isEntropyCollapse;

    // -------------------------------------------------------------------------
    // 3. Multi-Signal Consensus Aggregation
    // Count independent microstructural signals firing simultaneously
    // -------------------------------------------------------------------------
    let activeSignalCount = 0;
    if (isObiReversed) activeSignalCount++;
    if (isToxicVpin) activeSignalCount++;
    if (isAdverseFlow) activeSignalCount++;
    if (isHawkesBurst) activeSignalCount++;
    if (isAdverseSweep) activeSignalCount++;
    if (isEntropyCollapse) activeSignalCount++;

    out.activeSignalCount = activeSignalCount;

    // -------------------------------------------------------------------------
    // 4. Breach Evaluation: Consensus >= adversarialMinSignals (default: 2)
    // Concurrently with adverse price velocity shock exceeding dynamic ATR threshold
    // -------------------------------------------------------------------------
    if (activeSignalCount >= cfg.adversarialMinSignals && isPriceShock) {
      out.isBreached = true;
      out.reason = `ADVERSARIAL_CASCADE_EXIT_${slot.side}`;
    }

    return out;
  }
}
