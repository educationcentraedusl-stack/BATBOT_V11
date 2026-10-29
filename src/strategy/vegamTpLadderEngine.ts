/**
 * BATBOT_V11 HIGH-FREQUENCY TRADING SYSTEM
 * VEGAM (Volatility-Engineered & AI-Governed Adaptive Management) TP Ladder Engine
 *
 * Implements Layer 1 (ATR-Anchored TP Ladder) and Layer 2 (OBI-Weighted Dynamic Trailing SL)
 * per VEGAM Master Implementation Plan (2026 SOTA Exit Architecture).
 *
 * Guaranteed Invariants:
 * 1. TP1 >= RPM_min (Guaranteed fee coverage even under compressed volatility).
 * 2. High-precision zero-heap tick state machine (zero GC allocations in hot-path).
 * 3. Dynamic k_regime scaling: OBI book pressure, VPIN toxic flow clamp, and Hawkes intensity burst.
 */

import { PositionSlot } from "./positionLedger";

/**
 * Section 2.3: VEGAM Configuration Parameters
 */
export interface VegamTpLadderConfig {
  /** Short-term GK weight in composite ATR (default: 0.30) */
  gkAlpha: number;
  /** ATR multiple for TP1 (default: 1.00) */
  tp1AtrMultiplier: number;
  /** ATR multiple for TP2 (default: 2.50) */
  tp2AtrMultiplier: number;
  /** ATR multiple for TP3 trailing distance (default: 0.80) */
  tp3TrailAtrMultiplier: number;
  /** Fraction to close at TP1 (default: 0.35) */
  tp1SizeRatio: number;
  /** Fraction to close at TP2 (default: 0.40) */
  tp2SizeRatio: number;
  /** Fraction to trail-exit at TP3 (default: 0.25) */
  tp3SizeRatio: number;
  /** ROE% to activate dynamic trail (default: 0.50%) */
  trailActivationRoePct: number;
  /** OBI below which trail tightens (default: -0.20) */
  obiTightenThreshold: number;
  /** OBI above which trail expands (default: +0.20) */
  obiExpandThreshold: number;
  /** VPIN above which k_regime = 0.5 (default: 0.65) */
  vpinToxicFloor: number;
  /** Hawkes above which k_regime = 2.0 (default: 1.80) */
  hawkesExpansionThreshold: number;
  /** IC decay ratio to trigger CADME (default: 0.60) */
  aiDecayExitMultiplier: number;
  /** Min reversed signals to trigger emergency exit (default: 2) */
  adversarialMinSignals: number;
  /** Recalibrated HJB Risk Aversion Gamma (default: 4.20) */
  hjbRiskAversionGamma: number;
  /** Target horizon seconds for HJB boundary (default: 120.0) */
  hjbTargetHorizonSeconds: number;
  /** Maker fee rate (default: 0.0002 -> 2 bps) */
  makerFee: number;
  /** Taker fee rate (default: 0.0005 -> 5 bps) */
  takerFee: number;
}

/**
 * Exact default parameters from Section 2.3 of the Master Plan.
 */
export const DEFAULT_VEGAM_CONFIG: Readonly<VegamTpLadderConfig> = Object.freeze({
  gkAlpha: 0.30,
  tp1AtrMultiplier: 1.00,
  tp2AtrMultiplier: 2.50,
  tp3TrailAtrMultiplier: 0.80,
  tp1SizeRatio: 0.35,
  tp2SizeRatio: 0.40,
  tp3SizeRatio: 0.25,
  trailActivationRoePct: 0.50,
  obiTightenThreshold: -0.20,
  obiExpandThreshold: 0.20,
  vpinToxicFloor: 0.65,
  hawkesExpansionThreshold: 1.80,
  aiDecayExitMultiplier: 0.60,
  adversarialMinSignals: 2,
  hjbRiskAversionGamma: 4.20,
  hjbTargetHorizonSeconds: 120.0,
  makerFee: 0.0002,
  takerFee: 0.0005,
});

/**
 * Calculated Take-Profit Levels & Allocations
 */
export interface VegamTpLevels {
  tp1Price: number;
  tp2Price: number;
  tp1Qty: number;
  tp2Qty: number;
  tp3Qty: number;
  tp1Offset: number;
  tp2Offset: number;
  tp3TrailingDist: number;
  rpmMin: number;
}

/**
 * Result structure emitted by the Zero-GC tick evaluation loop
 */
export interface VegamTickResult {
  action: "NONE" | "TP1_RATCHET" | "TP2_REACHED" | "TRAIL_UPDATED" | "SL_TRIGGERED";
  kRegime: number;
  trailDist: number;
  proposedSl: number;
  currentSl: number;
  tp1Hit: boolean;
  tp2Hit: boolean;
  slHit: boolean;
  rawRoePct: number;
  peakRoe: number;
}

/**
 * Pre-allocated singleton for zero-GC static tick evaluation
 */
const STATIC_TICK_RESULT: VegamTickResult = {
  action: "NONE",
  kRegime: 1.0,
  trailDist: 0.0,
  proposedSl: 0.0,
  currentSl: 0.0,
  tp1Hit: false,
  tp2Hit: false,
  slHit: false,
  rawRoePct: 0.0,
  peakRoe: 0.0,
};

/**
 * Computes minimum required price move (RPM_min) to cover round-trip fees with safety buffer.
 * Formula from Section 1.2.3: RPM_min = (makerFee + takerFee * 1.5)
 */
export function computeRpmMin(
  leverage: number = 1.0,
  makerFee: number = 0.0002,
  takerFee: number = 0.0005
): number {
  const safeMaker = Number.isFinite(makerFee) && makerFee >= 0 ? makerFee : 0.0002;
  const safeTaker = Number.isFinite(takerFee) && takerFee >= 0 ? takerFee : 0.0005;
  const baseRpm = safeMaker + safeTaker * 1.5;
  return Math.max(0.0001, baseRpm);
}

/**
 * Computes the dynamic k_regime multiplier from order flow metrics.
 *
 * Precedence / Hierarchy:
 * 1. VPIN > 0.65 -> Toxic Flow: hard clamp k_regime = 0.5 (adverse selection protection)
 * 2. Hawkes > 1.80 -> High Intensity: expand k_regime = 2.0 (momentum extension)
 * 3. OBI directional book depth:
 *    - Book pressure against trade (< -0.20): k_regime = 0.8 (tighten to protect profit)
 *    - Supportive book depth (> +0.20): k_regime = 1.2 (expand to let trade breathe)
 *    - Neutral regime (-0.20 to +0.20): k_regime = 1.0 (baseline)
 */
export function computeKRegime(
  obi: number,
  vpin: number,
  hawkes: number,
  config?: VegamTpLadderConfig,
  side: "LONG" | "SHORT" = "LONG"
): number {
  const cfg = config ?? DEFAULT_VEGAM_CONFIG;

  // Condition 1: Toxic flow takes absolute risk priority
  if (Number.isFinite(vpin) && vpin >= cfg.vpinToxicFloor) {
    return 0.5;
  }

  // Condition 2: High order intensity momentum extension
  if (Number.isFinite(hawkes) && hawkes >= cfg.hawkesExpansionThreshold) {
    return 2.0;
  }

  // Conditions 3, 4, 5: Directional Order Book Imbalance (OBI)
  const safeObi = Number.isFinite(obi) ? obi : 0.0;
  const directionalObi = side === "SHORT" ? -safeObi : safeObi;

  if (directionalObi < cfg.obiTightenThreshold) {
    return 0.8;
  }
  if (directionalObi > cfg.obiExpandThreshold) {
    return 1.2;
  }

  return 1.0;
}

/**
 * Computes OBI-Weighted Dynamic Trailing Distance:
 * TrailDist_t = GK_ATR_composite * k_regime(t) [* entryPrice]
 */
export function computeObiWeightedTrailDistance(
  gkAtr: number,
  obi: number,
  vpin: number,
  hawkes: number,
  config?: VegamTpLadderConfig,
  entryPrice?: number,
  side: "LONG" | "SHORT" = "LONG"
): number {
  const cfg = config ?? DEFAULT_VEGAM_CONFIG;
  const safeAtr = Number.isFinite(gkAtr) && gkAtr > 0 ? gkAtr : 0.00906;
  const kRegime = computeKRegime(obi, vpin, hawkes, cfg, side);

  const relativeTrail = safeAtr * kRegime;
  if (typeof entryPrice === "number" && entryPrice > 0) {
    return relativeTrail * entryPrice;
  }
  return relativeTrail;
}

/**
 * Computes ATR-Anchored Take-Profit Ladder Levels:
 * TP1: entry + max(1 * GK_ATR, RPM_min)
 * TP2: entry + max(2.5 * GK_ATR, 2 * RPM_min)
 * TP3: peakPrice - 0.8 * GK_ATR (trailing distance)
 */
export function computeVegamTpLevels(
  entryPrice: number,
  gkAtrComposite: number,
  leverage: number,
  side: "LONG" | "SHORT",
  config?: VegamTpLadderConfig,
  totalQuantity?: number
): VegamTpLevels {
  const cfg = config ?? DEFAULT_VEGAM_CONFIG;
  const safePrice = Number.isFinite(entryPrice) && entryPrice > 0 ? entryPrice : 1.0;
  const safeAtr = Number.isFinite(gkAtrComposite) && gkAtrComposite > 0 ? gkAtrComposite : 0.00906;
  const rpmMin = computeRpmMin(leverage, cfg.makerFee, cfg.takerFee);

  // Assert TP1 offset is always >= RPM_min to guarantee round-trip fee coverage
  const tp1Offset = Math.max(cfg.tp1AtrMultiplier * safeAtr, rpmMin);
  const tp2Offset = Math.max(cfg.tp2AtrMultiplier * safeAtr, 2.0 * rpmMin);

  const isLong = side === "LONG";
  const tp1Price = isLong ? safePrice * (1.0 + tp1Offset) : safePrice * (1.0 - tp1Offset);
  const tp2Price = isLong ? safePrice * (1.0 + tp2Offset) : safePrice * (1.0 - tp2Offset);

  const tp3TrailingDist = cfg.tp3TrailAtrMultiplier * safeAtr * safePrice;

  let tp1Qty: number;
  let tp2Qty: number;
  let tp3Qty: number;

  if (typeof totalQuantity === "number" && totalQuantity > 0) {
    tp1Qty = totalQuantity * cfg.tp1SizeRatio;
    tp2Qty = totalQuantity * cfg.tp2SizeRatio;
    tp3Qty = Math.max(0, totalQuantity - tp1Qty - tp2Qty);
  } else {
    tp1Qty = cfg.tp1SizeRatio;
    tp2Qty = cfg.tp2SizeRatio;
    tp3Qty = cfg.tp3SizeRatio;
  }

  return {
    tp1Price,
    tp2Price,
    tp1Qty,
    tp2Qty,
    tp3Qty,
    tp1Offset,
    tp2Offset,
    tp3TrailingDist,
    rpmMin,
  };
}

/**
 * High-Performance Zero-GC Tick State Machine
 *
 * Mutates slot state in-place and reuses pre-allocated result structures.
 * Performs zero heap allocations per tick evaluation.
 */
export class VegamTpLadderEngine {
  private config: VegamTpLadderConfig;

  // Zero-GC Pre-allocated Cached Result Payload Ring Buffer (8 slots)
  private readonly tickResultRing: VegamTickResult[] = Array.from({ length: 8 }, () => ({
    action: "NONE",
    kRegime: 1.0,
    trailDist: 0.0,
    proposedSl: 0.0,
    currentSl: 0.0,
    tp1Hit: false,
    tp2Hit: false,
    slHit: false,
    rawRoePct: 0.0,
    peakRoe: 0.0,
  }));
  private tickRingIdx: number = 0;

  constructor(config?: Partial<VegamTpLadderConfig>) {
    this.config = config ? { ...DEFAULT_VEGAM_CONFIG, ...config } : { ...DEFAULT_VEGAM_CONFIG };
  }

  public getConfig(): Readonly<VegamTpLadderConfig> {
    return this.config;
  }

  public computeVegamTpLevels(
    entryPrice: number,
    gkAtrComposite: number,
    leverage: number,
    side: "LONG" | "SHORT",
    totalQuantity?: number
  ): VegamTpLevels {
    return computeVegamTpLevels(entryPrice, gkAtrComposite, leverage, side, this.config, totalQuantity);
  }

  public computeRpmMin(leverage?: number): number {
    return computeRpmMin(leverage, this.config.makerFee, this.config.takerFee);
  }

  public computeObiWeightedTrailDistance(
    gkAtr: number,
    obi: number,
    vpin: number,
    hawkes: number,
    entryPrice?: number,
    side: "LONG" | "SHORT" = "LONG"
  ): number {
    return computeObiWeightedTrailDistance(gkAtr, obi, vpin, hawkes, this.config, entryPrice, side);
  }

  public computeKRegime(
    obi: number,
    vpin: number,
    hawkes: number,
    side: "LONG" | "SHORT" = "LONG"
  ): number {
    return computeKRegime(obi, vpin, hawkes, this.config, side);
  }

  /**
   * Instance zero-GC tick state machine evaluation
   */
  public tick(
    slot: PositionSlot,
    markPrice: number,
    stoikovMicroPrice: number,
    obi: number,
    vpin: number,
    hawkes: number,
    gkAtrComposite?: number,
    leverage?: number
  ): VegamTickResult {
    const res = this.tickResultRing[this.tickRingIdx];
    this.tickRingIdx = (this.tickRingIdx + 1) & 7;

    return VegamTpLadderEngine.evaluateTickInternal(
      slot,
      markPrice,
      stoikovMicroPrice,
      obi,
      vpin,
      hawkes,
      gkAtrComposite,
      leverage,
      this.config,
      res
    );
  }

  /**
   * Static zero-GC tick state machine evaluation
   */
  public static tick(
    slot: PositionSlot,
    markPrice: number,
    stoikovMicroPrice: number,
    obi: number,
    vpin: number,
    hawkes: number,
    gkAtrComposite?: number,
    leverage?: number,
    config?: VegamTpLadderConfig
  ): VegamTickResult {
    return VegamTpLadderEngine.evaluateTickInternal(
      slot,
      markPrice,
      stoikovMicroPrice,
      obi,
      vpin,
      hawkes,
      gkAtrComposite,
      leverage,
      config ?? DEFAULT_VEGAM_CONFIG,
      STATIC_TICK_RESULT
    );
  }

  private static evaluateTickInternal(
    slot: PositionSlot,
    markPrice: number,
    stoikovMicroPrice: number,
    obi: number,
    vpin: number,
    hawkes: number,
    gkAtrComposite: number | undefined,
    leverage: number | undefined,
    cfg: VegamTpLadderConfig,
    out: VegamTickResult
  ): VegamTickResult {
    // Reset out struct fields
    out.action = "NONE";
    out.kRegime = 1.0;
    out.trailDist = 0.0;
    out.proposedSl = 0.0;
    out.currentSl = slot.stopLossPrice;
    out.tp1Hit = false;
    out.tp2Hit = false;
    out.slHit = false;
    out.rawRoePct = 0.0;
    out.peakRoe = slot.peakRoe ?? 0.0;

    if (!slot.isOccupied || markPrice <= 0 || slot.entryPrice <= 0) {
      return out;
    }

    const isLong = slot.side === "LONG";
    // Strict constitutional leverage enforcement: clamp strictly between 2.0x and 5.0x (default 2.0x)
    const effLev = typeof leverage === "number" && Number.isFinite(leverage) && leverage > 0
      ? Math.min(5.0, Math.max(2.0, leverage))
      : 2.0;

    // 1. Monotonic Peak/Trough Tracking (Orderflow-Aware via Stoikov MicroPrice)
    // Stoikov microprice accounts for short-term book imbalance skew; ingest as leading price metric
    const effectiveHighPrice = Number.isFinite(stoikovMicroPrice) && stoikovMicroPrice > markPrice
      ? stoikovMicroPrice
      : markPrice;
    const effectiveLowPrice = Number.isFinite(stoikovMicroPrice) && stoikovMicroPrice > 0 && stoikovMicroPrice < markPrice
      ? stoikovMicroPrice
      : markPrice;

    if (isLong) {
      if (slot.peakPrice === undefined || slot.peakPrice <= 0 || effectiveHighPrice > slot.peakPrice) {
        slot.peakPrice = effectiveHighPrice;
      }
    } else {
      if (slot.troughPrice === undefined || slot.troughPrice <= 0 || effectiveLowPrice < slot.troughPrice) {
        slot.troughPrice = effectiveLowPrice;
      }
    }

    // 2. Return on Equity (ROE) Calculation
    const priceDiff = isLong ? (markPrice - slot.entryPrice) : (slot.entryPrice - markPrice);
    const rawRoePct = (priceDiff / slot.entryPrice) * effLev * 100.0;
    out.rawRoePct = rawRoePct;

    if (slot.peakRoe === undefined || rawRoePct > slot.peakRoe) {
      slot.peakRoe = rawRoePct;
    }
    out.peakRoe = slot.peakRoe;

    // 3. Dynamic k_regime Calculation (Zero allocation)
    const kRegime = computeKRegime(obi, vpin, hawkes, cfg, slot.side);
    out.kRegime = kRegime;

    // 4. Volatility Scaling & Trailing Distance
    const safeAtr = typeof gkAtrComposite === "number" && gkAtrComposite > 0 ? gkAtrComposite : 0.00906;
    const trailDist = safeAtr * kRegime * slot.entryPrice;
    out.trailDist = trailDist;

    // 5. Layer 1: TP1 Hit Evaluation & Risk-Free SL Ratchet
    if (slot.takeProfitPrice > 0) {
      const isTp1Reached = isLong ? markPrice >= slot.takeProfitPrice : markPrice <= slot.takeProfitPrice;
      if (isTp1Reached) {
        out.tp1Hit = true;
        if (!slot.tpStageReached || slot.tpStageReached < 1) {
          slot.tpStageReached = 1;
          slot.breakEvenLocked = true;
          // Ratchet SL to Break-Even Price (covering entry + round-trip fees) to secure 100% risk-free trade on remainder
          const bePrice = (slot.breakEvenPrice && slot.breakEvenPrice > 0) ? slot.breakEvenPrice : slot.entryPrice;
          if (isLong) {
            if (slot.stopLossPrice < bePrice) {
              slot.stopLossPrice = bePrice;
            }
          } else {
            if (slot.stopLossPrice <= 0 || slot.stopLossPrice > bePrice) {
              slot.stopLossPrice = bePrice;
            }
          }
          out.action = "TP1_RATCHET";
        }
      }
    }

    // 5b. Layer 1: TP2 Hit Evaluation (Primary Momentum Capture)
    const tp2Price = slot.tpStagePrices?.[1] ?? slot.tpPrices?.[1] ?? (slot.tpStageReached === 1 && slot.takeProfitPrice > 0 ? slot.takeProfitPrice : 0);
    if (tp2Price > 0) {
      const isTp2Reached = isLong ? markPrice >= tp2Price : markPrice <= tp2Price;
      if (isTp2Reached) {
        out.tp2Hit = true;
        if (!slot.tpStageReached || slot.tpStageReached < 2) {
          slot.tpStageReached = 2;
          // Trail SL to TP1 level upon hitting TP2 to lock primary profits
          const tp1Price = (slot.tpStagePrices?.[0] ?? slot.tpPrices?.[0]) || (slot.takeProfitPrice > 0 ? slot.takeProfitPrice : slot.entryPrice);
          if (isLong) {
            if (slot.stopLossPrice < tp1Price) {
              slot.stopLossPrice = tp1Price;
            }
          } else {
            if (slot.stopLossPrice <= 0 || slot.stopLossPrice > tp1Price) {
              slot.stopLossPrice = tp1Price;
            }
          }
          out.action = "TP2_REACHED";
        }
      }
    }

    // 6. Layer 2: OBI-Weighted Dynamic Trailing SL
    // Activates once rawRoePct >= trailActivationRoePct (0.50%) or peakRoe >= trailActivationRoePct
    const currentPeakRoe = slot.peakRoe ?? 0.0;
    const isTrailActive = rawRoePct >= cfg.trailActivationRoePct || currentPeakRoe >= cfg.trailActivationRoePct;
    if (isTrailActive) {
      if (isLong) {
        const proposedSl = (slot.peakPrice ?? markPrice) - trailDist;
        out.proposedSl = proposedSl;
        if (proposedSl > slot.stopLossPrice) {
          slot.stopLossPrice = proposedSl;
          if (out.action === "NONE") {
            out.action = "TRAIL_UPDATED";
          }
        }
      } else {
        const proposedSl = (slot.troughPrice ?? markPrice) + trailDist;
        out.proposedSl = proposedSl;
        if (slot.stopLossPrice <= 0 || proposedSl < slot.stopLossPrice) {
          slot.stopLossPrice = proposedSl;
          if (out.action === "NONE") {
            out.action = "TRAIL_UPDATED";
          }
        }
      }
    }

    out.currentSl = slot.stopLossPrice;

    // 7. Stop-Loss Trigger Evaluation
    if (isLong) {
      if (slot.stopLossPrice > 0 && markPrice <= slot.stopLossPrice) {
        out.slHit = true;
        out.action = "SL_TRIGGERED";
      }
    } else {
      if (slot.stopLossPrice > 0 && markPrice >= slot.stopLossPrice) {
        out.slHit = true;
        out.action = "SL_TRIGGERED";
      }
    }

    return out;
  }
}
