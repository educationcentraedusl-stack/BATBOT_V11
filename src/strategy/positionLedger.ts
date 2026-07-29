export interface PositionLot {
  price: number;
  quantity: number;
  timestamp: number;
}

export interface PositionSummary {
  symbol: string;
  side: "FLAT" | "LONG" | "SHORT";
  netQuantity: number;
  averageEntryPrice: number;
  unrealizedPnl: number;
  cumulativeRealizedPnl: number;
  cumulativeFees: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
}

export interface ClosedTradeInfo {
  timestamp: number;
  symbol: string;
  side: "LONG" | "SHORT";
  size: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  durationMs: number;
  roePercent: number;
  pnlUsdt: number;
}

export interface FillReconciliationResult {
  symbol: string;
  fillSide: "BUY" | "SELL";
  fillPrice: number;
  fillQuantity: number;
  fee: number;
  closedQuantity: number;
  realizedPnl: number;
  positionSideAfterFill: "FLAT" | "LONG" | "SHORT";
  netQuantityAfterFill: number;
  averageEntryPriceAfterFill: number;
  closedTrade?: ClosedTradeInfo;
}

const DEFAULT_MAX_LOTS = 1024;

export class PositionLedger {
  private symbol: string;
  private lots: PositionLot[];
  private lotHead = 0;
  private lotTail = 0;
  private lotCount = 0;
  private maxCapacity: number;

  private side: "FLAT" | "LONG" | "SHORT" = "FLAT";
  private netQuantity = 0;
  private averageEntryPrice = 0;
  private positionOpenTime = 0;
  private cumulativeRealizedPnl = 0;
  private cumulativeFees = 0;
  private totalTrades = 0;
  private winningTrades = 0;
  private losingTrades = 0;

  // Pre-allocated summary object for zero-GC per-tick telemetry
  private cachedSummary: PositionSummary;

  // Pre-allocated result object for zero-GC hot path return
  private reconciliationResult: FillReconciliationResult = {
    symbol: "",
    fillSide: "BUY",
    fillPrice: 0,
    fillQuantity: 0,
    fee: 0,
    closedQuantity: 0,
    realizedPnl: 0,
    positionSideAfterFill: "FLAT",
    netQuantityAfterFill: 0,
    averageEntryPriceAfterFill: 0,
    closedTrade: undefined,
  };

  constructor(symbol: string = "BTCUSDT", maxCapacity: number = DEFAULT_MAX_LOTS) {
    this.symbol = symbol;
    this.maxCapacity = maxCapacity;
    this.lots = new Array<PositionLot>(this.maxCapacity);
    for (let i = 0; i < this.maxCapacity; i++) {
      this.lots[i] = { price: 0, quantity: 0, timestamp: 0 };
    }
    this.reconciliationResult.symbol = symbol;

    this.cachedSummary = {
      symbol: this.symbol,
      side: "FLAT",
      netQuantity: 0,
      averageEntryPrice: 0,
      unrealizedPnl: 0,
      cumulativeRealizedPnl: 0,
      cumulativeFees: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
    };
  }

  /**
   * Synchronizes an existing active position from Binance REST API on startup.
   * Directly sets side, netQuantity, averageEntryPrice and initial FIFO lot without generating synthetic realized trade PnL.
   */
  public syncActivePosition(
    side: "LONG" | "SHORT",
    netQuantity: number,
    averageEntryPrice: number
  ): void {
    this.reset();
    if (netQuantity > 0 && averageEntryPrice > 0) {
      this.side = side;
      this.netQuantity = netQuantity;
      this.averageEntryPrice = averageEntryPrice;
      this.positionOpenTime = Date.now();
      this.pushLot(averageEntryPrice, netQuantity);
      console.log(`[PositionLedger] Position state synced on startup: ${side} ${netQuantity} @ $${averageEntryPrice}`);
    }
  }

  /**
   * Processes a filled order execution using FIFO lot matching.
   * Calculates closed lot Realized PnL, updates average cost basis, and returns reconciliation details.
   * Zero heap allocations during fill processing.
   */
  public processFill(
    symbol: string,
    fillSide: "BUY" | "SELL",
    fillPrice: number,
    fillQuantity: number,
    fee: number,
    exitReason?: string
  ): FillReconciliationResult {
    this.cumulativeFees += fee;
    this.reconciliationResult.closedTrade = undefined;

    let remainingFillQty = fillQuantity;
    let totalClosedQty = 0;
    let realizedPnlDelta = 0;

    const prevSide = this.side;
    const prevEntryPrice = this.averageEntryPrice;
    const prevOpenTime = this.positionOpenTime;

    if (this.side === "FLAT") {
      // Open new position
      this.side = fillSide === "BUY" ? "LONG" : "SHORT";
      this.netQuantity = fillQuantity;
      this.averageEntryPrice = fillPrice;
      this.positionOpenTime = Date.now();
      this.pushLot(fillPrice, fillQuantity);
    } else if (
      (this.side === "LONG" && fillSide === "BUY") ||
      (this.side === "SHORT" && fillSide === "SELL")
    ) {
      // Adding to existing position on the same side
      const currentNotional = this.netQuantity * this.averageEntryPrice;
      const newNotional = fillQuantity * fillPrice;
      this.netQuantity += fillQuantity;
      this.averageEntryPrice = (currentNotional + newNotional) / this.netQuantity;
      this.pushLot(fillPrice, fillQuantity);
    } else {
      // Opposing side fill: closing or reducing existing position via FIFO lot matching
      while (remainingFillQty > 0 && this.lotCount > 0) {
        const lotSlot = this.lots[this.lotTail];
        const matchQty = Math.min(remainingFillQty, lotSlot.quantity);

        const lotPnl =
          this.side === "LONG"
            ? (fillPrice - lotSlot.price) * matchQty
            : (lotSlot.price - fillPrice) * matchQty;

        realizedPnlDelta += lotPnl;
        totalClosedQty += matchQty;
        remainingFillQty -= matchQty;
        lotSlot.quantity -= matchQty;

        if (lotSlot.quantity <= 1e-9) {
          // Lot fully closed: advance tail
          lotSlot.quantity = 0;
          this.lotTail = (this.lotTail + 1) % this.maxCapacity;
          this.lotCount--;
        }
      }

      this.netQuantity -= totalClosedQty;
      const isCompletelyClosed = this.netQuantity <= 1e-9;
      const wasPositionFlipped = remainingFillQty > 1e-9;

      if (isCompletelyClosed) {
        // Position fully closed
        this.netQuantity = 0;
        this.averageEntryPrice = 0;
        this.side = "FLAT";
        this.lotHead = 0;
        this.lotTail = 0;
        this.lotCount = 0;

        // If fill quantity exceeded closed lots, open position on opposite side with leftover quantity
        if (wasPositionFlipped) {
          this.side = fillSide === "BUY" ? "LONG" : "SHORT";
          this.netQuantity = remainingFillQty;
          this.averageEntryPrice = fillPrice;
          this.positionOpenTime = Date.now();
          this.pushLot(fillPrice, remainingFillQty);
        } else {
          this.positionOpenTime = 0;
        }
      }

      // Pro-rate fee for closed lot portion to maintain precise PnL accounting during lot flips
      const closedFee = fillQuantity > 0 ? fee * (totalClosedQty / fillQuantity) : 0;
      const netRealizedTradePnl = realizedPnlDelta - closedFee;
      this.cumulativeRealizedPnl += netRealizedTradePnl;
      this.totalTrades++;

      if (netRealizedTradePnl > 0) {
        this.winningTrades++;
      } else if (netRealizedTradePnl < 0) {
        this.losingTrades++;
      }

      // If the trade was completely closed (or flipped), record closed trade info for CSV logger
      if (totalClosedQty > 0 && (isCompletelyClosed || wasPositionFlipped) && prevSide !== "FLAT") {
        const durationMs = prevOpenTime > 0 ? Math.max(0, Date.now() - prevOpenTime) : 0;
        const roePercent =
          prevEntryPrice > 0
            ? (((fillPrice - prevEntryPrice) / prevEntryPrice) * 100) * (prevSide === "LONG" ? 1 : -1)
            : 0;

        this.reconciliationResult.closedTrade = {
          timestamp: Date.now(),
          symbol,
          side: prevSide as "LONG" | "SHORT",
          size: totalClosedQty,
          entryPrice: prevEntryPrice,
          exitPrice: fillPrice,
          exitReason: exitReason || "SIGNAL_EXIT",
          durationMs,
          roePercent,
          pnlUsdt: netRealizedTradePnl,
        };
      }
    }

    // Populate static result structure
    const fillClosedFee = fillQuantity > 0 ? fee * (totalClosedQty / fillQuantity) : 0;
    this.reconciliationResult.symbol = symbol;
    this.reconciliationResult.fillSide = fillSide;
    this.reconciliationResult.fillPrice = fillPrice;
    this.reconciliationResult.fillQuantity = fillQuantity;
    this.reconciliationResult.fee = fee;
    this.reconciliationResult.closedQuantity = totalClosedQty;
    this.reconciliationResult.realizedPnl = totalClosedQty > 0 ? realizedPnlDelta - fillClosedFee : 0;
    this.reconciliationResult.positionSideAfterFill = this.side;
    this.reconciliationResult.netQuantityAfterFill = this.netQuantity;
    this.reconciliationResult.averageEntryPriceAfterFill = this.averageEntryPrice;

    return this.reconciliationResult;
  }

  private pushLot(price: number, quantity: number): void {
    const slot = this.lots[this.lotHead];
    slot.price = price;
    slot.quantity = quantity;
    slot.timestamp = Date.now();

    this.lotHead = (this.lotHead + 1) % this.maxCapacity;
    if (this.lotCount < this.maxCapacity) {
      this.lotCount++;
    } else {
      // Buffer full: drop oldest lot
      this.lotTail = (this.lotTail + 1) % this.maxCapacity;
    }
  }

  /**
   * Computes floating Mark-to-Market Unrealized PnL.
   */
  public getUnrealizedPnl(currentMarkPrice: number): number {
    if (this.side === "FLAT" || this.netQuantity === 0 || currentMarkPrice <= 0) {
      return 0;
    }
    if (this.side === "LONG") {
      return (currentMarkPrice - this.averageEntryPrice) * this.netQuantity;
    } else {
      return (this.averageEntryPrice - currentMarkPrice) * this.netQuantity;
    }
  }

  public getSummary(currentMarkPrice: number = 0): PositionSummary {
    this.cachedSummary.symbol = this.symbol;
    this.cachedSummary.side = this.side;
    this.cachedSummary.netQuantity = Number(this.netQuantity.toFixed(6));
    this.cachedSummary.averageEntryPrice = Number(this.averageEntryPrice.toFixed(4));
    this.cachedSummary.unrealizedPnl = Number(this.getUnrealizedPnl(currentMarkPrice).toFixed(4));
    this.cachedSummary.cumulativeRealizedPnl = Number(this.cumulativeRealizedPnl.toFixed(4));
    this.cachedSummary.cumulativeFees = Number(this.cumulativeFees.toFixed(4));
    this.cachedSummary.totalTrades = this.totalTrades;
    this.cachedSummary.winningTrades = this.winningTrades;
    this.cachedSummary.losingTrades = this.losingTrades;

    return this.cachedSummary;
  }

  public reset(): void {
    this.lotHead = 0;
    this.lotTail = 0;
    this.lotCount = 0;
    this.side = "FLAT";
    this.netQuantity = 0;
    this.averageEntryPrice = 0;
    this.positionOpenTime = 0;
    this.cumulativeRealizedPnl = 0;
    this.cumulativeFees = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
  }
}
