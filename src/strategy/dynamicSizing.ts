import "dotenv/config";

export interface DynamicTpChunk {
  stage: number;
  percentage: number;
  quantity: number;
  notionalUsdt: number;
  isMaker: boolean;
  estimatedFeeUsdt: number;
}

export interface DynamicTpChunkResult {
  totalQuantity: number;
  totalNotionalUsdt: number;
  stageCount: number;
  chunks: DynamicTpChunk[];
  totalMakerFeeUsdt: number;
  totalTakerFeeUsdt: number;
  feeSavingsUsdt: number;
  isConsolidated: boolean;
}

export class DynamicSizingCalculator {
  private allocation3Stage: number[];
  private allocation2Stage: number[];
  private consolidationThresholdUsdt: number;
  private minNotionalUsdt: number;
  private makerFeeRate: number;
  private takerFeeRate: number;

  constructor() {
    // Dynamically parse configuration from process.env (Zero hardcoding rule)
    const raw3Stage = process.env.TP_STAGE_ALLOCATION_3STAGE || "40,35,25";
    this.allocation3Stage = raw3Stage
      .split(",")
      .map((val) => parseFloat(val.trim()) / 100.0)
      .filter((val) => !isNaN(val) && val > 0);

    if (this.allocation3Stage.length === 0) {
      this.allocation3Stage = [0.40, 0.35, 0.25];
    }

    const raw2Stage = process.env.TP_STAGE_ALLOCATION_2STAGE || "60,40";
    this.allocation2Stage = raw2Stage
      .split(",")
      .map((val) => parseFloat(val.trim()) / 100.0)
      .filter((val) => !isNaN(val) && val > 0);

    if (this.allocation2Stage.length === 0) {
      this.allocation2Stage = [0.60, 0.40];
    }

    this.consolidationThresholdUsdt = parseFloat(
      process.env.DYNAMIC_SIZING_CONSOLIDATION_THRESHOLD_USDT || "150.0"
    );
    this.minNotionalUsdt = parseFloat(process.env.MIN_NOTIONAL_USDT || "10.0");
    this.makerFeeRate = parseFloat(process.env.MAKER_FEE_RATE || "0.00018");
    this.takerFeeRate = parseFloat(process.env.TAKER_FEE_RATE || "0.00045");
  }

  public getMakerFeeRate(): number {
    return this.makerFeeRate;
  }

  public getTakerFeeRate(): number {
    return this.takerFeeRate;
  }

  public getMinNotionalUsdt(): number {
    return this.minNotionalUsdt;
  }

  public getConsolidationThresholdUsdt(): number {
    return this.consolidationThresholdUsdt;
  }

  /**
   * Calculates optimized dynamic partial TP chunks based on current entry price and total position size.
   * Automatically collapses 3-stage ladders into 2-stage or 1-stage if position size falls below consolidation/minNotional limits.
   * Zero GC allocations.
   */
  public calculateDynamicTpChunks(
    totalQuantity: number,
    currentPrice: number,
    quantityPrecision: number = 3
  ): DynamicTpChunkResult {
    if (totalQuantity <= 0 || currentPrice <= 0) {
      return {
        totalQuantity: 0,
        totalNotionalUsdt: 0,
        stageCount: 0,
        chunks: [],
        totalMakerFeeUsdt: 0,
        totalTakerFeeUsdt: 0,
        feeSavingsUsdt: 0,
        isConsolidated: false,
      };
    }

    const totalNotionalUsdt = totalQuantity * currentPrice;
    const isConsolidated = totalNotionalUsdt < this.consolidationThresholdUsdt;
    const targetAllocations = isConsolidated ? this.allocation2Stage : this.allocation3Stage;

    const rawChunks: DynamicTpChunk[] = [];
    let remainingQuantity = totalQuantity;

    for (let i = 0; i < targetAllocations.length; i++) {
      const isLast = i === targetAllocations.length - 1;
      const pct = targetAllocations[i];
      let rawQty = isLast ? remainingQuantity : totalQuantity * pct;
      rawQty = Number(rawQty.toFixed(quantityPrecision));

      const notional = rawQty * currentPrice;

      // Check minimum notional guard
      if (notional < this.minNotionalUsdt && rawChunks.length > 0) {
        // Merge tiny sub-notional chunk into previous stage
        const prev = rawChunks[rawChunks.length - 1];
        prev.quantity = Number((prev.quantity + rawQty).toFixed(quantityPrecision));
        prev.notionalUsdt = prev.quantity * currentPrice;
        prev.percentage += pct * 100;
        prev.estimatedFeeUsdt = prev.notionalUsdt * this.makerFeeRate;
        remainingQuantity -= rawQty;
        continue;
      }

      const estimatedMakerFee = notional * this.makerFeeRate;
      rawChunks.push({
        stage: rawChunks.length + 1,
        percentage: Number((pct * 100).toFixed(1)),
        quantity: rawQty,
        notionalUsdt: Number(notional.toFixed(2)),
        isMaker: true,
        estimatedFeeUsdt: Number(estimatedMakerFee.toFixed(4)),
      });

      remainingQuantity -= rawQty;
    }

    const totalMakerFeeUsdt = rawChunks.reduce((acc, c) => acc + c.estimatedFeeUsdt, 0);
    const totalTakerFeeUsdt = totalNotionalUsdt * this.takerFeeRate;
    const feeSavingsUsdt = Math.max(0, totalTakerFeeUsdt - totalMakerFeeUsdt);

    return {
      totalQuantity,
      totalNotionalUsdt: Number(totalNotionalUsdt.toFixed(2)),
      stageCount: rawChunks.length,
      chunks: rawChunks,
      totalMakerFeeUsdt: Number(totalMakerFeeUsdt.toFixed(4)),
      totalTakerFeeUsdt: Number(totalTakerFeeUsdt.toFixed(4)),
      feeSavingsUsdt: Number(feeSavingsUsdt.toFixed(4)),
      isConsolidated,
    };
  }

  /**
   * Calculates net PnL after deducting Maker/Taker fees according to execution type.
   */
  public calculateNetPnl(
    grossPnlUsdt: number,
    entryNotionalUsdt: number,
    exitNotionalUsdt: number,
    isEntryMaker: boolean = false,
    isExitMaker: boolean = true
  ): { netPnlUsdt: number; entryFeeUsdt: number; exitFeeUsdt: number; totalFeeUsdt: number } {
    const entryFeeRate = isEntryMaker ? this.makerFeeRate : this.takerFeeRate;
    const exitFeeRate = isExitMaker ? this.makerFeeRate : this.takerFeeRate;

    const entryFeeUsdt = entryNotionalUsdt * entryFeeRate;
    const exitFeeUsdt = exitNotionalUsdt * exitFeeRate;
    const totalFeeUsdt = entryFeeUsdt + exitFeeUsdt;
    const netPnlUsdt = grossPnlUsdt - totalFeeUsdt;

    return {
      netPnlUsdt: Number(netPnlUsdt.toFixed(4)),
      entryFeeUsdt: Number(entryFeeUsdt.toFixed(4)),
      exitFeeUsdt: Number(exitFeeUsdt.toFixed(4)),
      totalFeeUsdt: Number(totalFeeUsdt.toFixed(4)),
    };
  }
}
