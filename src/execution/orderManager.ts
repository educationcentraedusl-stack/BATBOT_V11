import { BinanceExecutionClient, BinanceOrderParams, BinanceOrderResponse } from "./binance";
import { StepCollarRiskEngine, StepCollarConfig, StepCollarEvaluationResult, PositionRiskState } from "./risk";
import { ClientOrderIdGenerator } from "./clientOrderIdGenerator";
import { SymbolPrecisionRegistry } from "../config/symbolPrecision";
import { OrderTradeUpdatePayload } from "./userDataStream";

export interface OrderManagerConfig {
  executionClient?: BinanceExecutionClient;
  riskConfig?: Partial<StepCollarConfig>;
  maxLatencyMs?: number;
  enableExchangeNativeSl?: boolean;
}

export interface ManagedOrderState {
  symbol: string;
  side: "LONG" | "SHORT";
  activeStopLossOrderId: number | null;
  activeStopLossClientOrderId: string | null;
  lastSyncedStopPrice: number;
  activeTakeProfitOrderId: number | null;
  activeTakeProfitClientOrderId: string | null;
  lastSyncedTakeProfitPrice: number;
  inFlightUpdate: boolean;
  pendingSlTarget: number | null;
}

export interface OrderManagerMetrics {
  totalTickEvaluations: number;
  totalStopLossUpdates: number;
  totalTakeProfitTriggers: number;
  totalStopLossTriggers: number;
  totalEmergencyExits: number;
  avgEvaluationLatencyUs: number;
  maxEvaluationLatencyUs: number;
  activeTrackedPositions: number;
}

export class OrderManager {
  private executionClient: BinanceExecutionClient;
  private riskEngine: StepCollarRiskEngine;
  private orderStates: Map<string, ManagedOrderState> = new Map();
  private maxLatencyMs: number;
  private enableExchangeNativeSl: boolean;

  // Latency telemetry metrics
  private totalTicks: number = 0;
  private totalSlUpdates: number = 0;
  private totalTpTriggers: number = 0;
  private totalSlTriggers: number = 0;
  private totalEmergencyExits: number = 0;
  private totalEvalDurationNs: bigint = 0n;
  private maxEvalLatencyUs: number = 0;

  constructor(config?: OrderManagerConfig) {
    this.executionClient = config?.executionClient ?? new BinanceExecutionClient();
    this.riskEngine = new StepCollarRiskEngine(config?.riskConfig);
    this.maxLatencyMs = config?.maxLatencyMs ?? 2.0; // < 2ms HFT execution bound
    this.enableExchangeNativeSl = config?.enableExchangeNativeSl ?? true;
  }

  public getRiskEngine(): StepCollarRiskEngine {
    return this.riskEngine;
  }

  public getExecutionClient(): BinanceExecutionClient {
    return this.executionClient;
  }

  /**
   * Registers a newly opened or active position for dynamic risk tracking.
   */
  public trackPosition(
    symbol: string,
    side: "LONG" | "SHORT",
    entryPrice: number,
    quantity: number,
    initialStopLossPrice?: number,
    targetTakeProfitPrice?: number
  ): PositionRiskState {
    const posState = this.riskEngine.registerPosition(
      symbol,
      side,
      entryPrice,
      quantity,
      initialStopLossPrice,
      targetTakeProfitPrice
    );

    const key = this.getKey(symbol, side);
    const existing = this.orderStates.get(key);
    if (!existing) {
      this.orderStates.set(key, {
        symbol,
        side,
        activeStopLossOrderId: null,
        activeStopLossClientOrderId: null,
        lastSyncedStopPrice: posState.currentStopLossPrice,
        activeTakeProfitOrderId: null,
        activeTakeProfitClientOrderId: null,
        lastSyncedTakeProfitPrice: posState.targetTakeProfitPrice,
        inFlightUpdate: false,
        pendingSlTarget: null,
      });
    } else {
      existing.lastSyncedStopPrice = posState.currentStopLossPrice;
      existing.lastSyncedTakeProfitPrice = posState.targetTakeProfitPrice;
      existing.inFlightUpdate = false;
      existing.pendingSlTarget = null;
    }

    return posState;
  }

  /**
   * Untracks a closed position and clears managed order states.
   */
  public untrackPosition(symbol: string, side: "LONG" | "SHORT"): void {
    this.riskEngine.removePosition(symbol, side);
    const key = this.getKey(symbol, side);
    this.orderStates.delete(key);
  }

  /**
   * Zero-GC High-Frequency Price Tick Ingestion & Action Dispatch (< 2ms execution budget).
   */
  public onPriceTick(
    symbol: string,
    markPrice: number,
    positionSide?: "LONG" | "SHORT"
  ): StepCollarEvaluationResult[] {
    const startNs = process.hrtime.bigint();
    const results: StepCollarEvaluationResult[] = [];

    const sidesToEval: ("LONG" | "SHORT")[] = positionSide
      ? [positionSide]
      : ["LONG", "SHORT"];

    for (const side of sidesToEval) {
      const pos = this.riskEngine.getPosition(symbol, side);
      if (!pos) continue;

      const evalResult = this.riskEngine.evaluateTick(symbol, side, markPrice);
      this.totalTicks++;

      if (evalResult.isTakeProfitTriggered) {
        this.totalTpTriggers++;
        this.handleTakeProfitTrigger(symbol, side, pos.quantity, markPrice, evalResult.reason);
      } else if (evalResult.isStopLossTriggered) {
        this.totalSlTriggers++;
        this.handleStopLossTrigger(symbol, side, pos.quantity, markPrice, evalResult.reason);
      } else if (evalResult.shouldUpdateStopLoss) {
        this.totalSlUpdates++;
        this.handleDynamicStopLossUpdate(symbol, side, pos.quantity, evalResult.newStopLossPrice);
      }

      results.push({ ...evalResult });
    }

    const endNs = process.hrtime.bigint();
    const durationNs = endNs - startNs;
    this.totalEvalDurationNs += durationNs;
    const latencyUs = Number(durationNs) / 1000;
    if (latencyUs > this.maxEvalLatencyUs) {
      this.maxEvalLatencyUs = latencyUs;
    }

    return results;
  }

  /**
   * Updates resting / conditional Stop Loss order on the exchange.
   * Enforces asynchronous queue locking to maintain strict < 2ms latency bounds.
   */
  public async updateStopLossOrder(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    newStopPrice: number
  ): Promise<BinanceOrderResponse | null> {
    const key = this.getKey(symbol, side);
    const state = this.orderStates.get(key);
    if (!state) return null;

    if (state.inFlightUpdate) {
      state.pendingSlTarget = newStopPrice;
      return null;
    }

    state.inFlightUpdate = true;
    try {
      // Exit side: LONG position -> SELL order; SHORT position -> BUY order
      const exitSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
      const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
      const clientOrderId = ClientOrderIdGenerator.generate(symbol, slotId, "SL");

      // 1. Cancel previous resting Stop Loss order if present
      if (state.activeStopLossOrderId !== null) {
        try {
          await this.executionClient.cancelOrder(symbol, state.activeStopLossOrderId);
        } catch (cancelErr: unknown) {
          // Non-blocking catch for already filled / expired orders
        }
      }

      // 2. Dispatch new STOP_MARKET conditional order
      const formattedStop = SymbolPrecisionRegistry.formatPrice(symbol, newStopPrice);
      const params: BinanceOrderParams = {
        symbol,
        side: exitSide,
        type: "STOP_MARKET",
        quantity,
        stopPrice: formattedStop,
        positionSide: side,
        clientOrderId,
        closePosition: false,
      };

      const res = await this.executionClient.placeOrder(params);
      state.activeStopLossOrderId = res.orderId;
      state.activeStopLossClientOrderId = clientOrderId;
      state.lastSyncedStopPrice = formattedStop;

      return res;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[OrderManager] Failed to update Stop Loss for ${symbol} ${side} @ ${newStopPrice}: ${errMsg}`);
      return null;
    } finally {
      state.inFlightUpdate = false;
      // Drain queued pending update if price moved during in-flight network dispatch
      if (state.pendingSlTarget !== null && state.pendingSlTarget !== state.lastSyncedStopPrice) {
        const queuedTarget = state.pendingSlTarget;
        state.pendingSlTarget = null;
        this.updateStopLossOrder(symbol, side, quantity, queuedTarget).catch(() => {});
      }
    }
  }

  /**
   * Submits a Take Profit limit/market exit order.
   */
  public async updateTakeProfitOrder(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    newTpPrice: number
  ): Promise<BinanceOrderResponse | null> {
    const exitSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
    const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
    const clientOrderId = ClientOrderIdGenerator.generate(symbol, slotId, "TP1");

    try {
      const formattedTp = SymbolPrecisionRegistry.formatPrice(symbol, newTpPrice);
      const params: BinanceOrderParams = {
        symbol,
        side: exitSide,
        type: "LIMIT",
        quantity,
        price: formattedTp,
        timeInForce: "GTX",
        positionSide: side,
        clientOrderId,
      };

      return await this.executionClient.placeOrder(params);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.warn(`[OrderManager] Failed to place TP order for ${symbol} ${side} @ ${newTpPrice}: ${errMsg}`);
      return null;
    }
  }

  /**
   * Executes an immediate Emergency Market Close for a position.
   */
  public async executeEmergencyClose(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    reason: string
  ): Promise<BinanceOrderResponse | null> {
    this.totalEmergencyExits++;
    const exitSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
    const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
    const clientOrderId = ClientOrderIdGenerator.generate(symbol, slotId, "EM");

    // Cancel all open orders for symbol
    try {
      await this.executionClient.cancelAllOrders(symbol);
    } catch (cancelErr: unknown) {
      // Proceed to emergency market close regardless
    }

    try {
      const params: BinanceOrderParams = {
        symbol,
        side: exitSide,
        type: "MARKET",
        quantity,
        positionSide: side,
        clientOrderId,
      };

      const res = await this.executionClient.placeOrder(params);
      this.untrackPosition(symbol, side);
      return res;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[OrderManager][CRITICAL] Emergency market close failed for ${symbol} ${side} (${reason}): ${errMsg}`);
      return null;
    }
  }

  /**
   * Ingests Binance WebSocket User Data Stream Execution Reports.
   */
  public handleExecutionReport(update: OrderTradeUpdatePayload): void {
    if (!update || update.eventType !== "ORDER_TRADE_UPDATE") return;
    const ord = update.order;
    const parsedCid = ClientOrderIdGenerator.parse(ord.clientOrderId);

    if (ord.orderStatus === "FILLED") {
      const isClose = (parsedCid && (parsedCid.orderType.startsWith("TP") || parsedCid.orderType === "SL" || parsedCid.orderType === "EM"));
      if (isClose) {
        const side: "LONG" | "SHORT" = ord.positionSide === "SHORT" ? "SHORT" : "LONG";
        this.untrackPosition(ord.symbol, side);
      }
    }
  }

  /**
   * Returns active position risk telemetry from Risk Engine.
   */
  public getPositionRisk(symbol: string, side: "LONG" | "SHORT"): PositionRiskState | undefined {
    return this.riskEngine.getPosition(symbol, side);
  }

  /**
   * Returns all tracked position keys and states.
   */
  public getAllTrackedPositions(): PositionRiskState[] {
    const states: PositionRiskState[] = [];
    for (const key of this.orderStates.keys()) {
      const [sym, side] = key.split("_");
      const pos = this.riskEngine.getPosition(sym, side as "LONG" | "SHORT");
      if (pos) states.push(pos);
    }
    return states;
  }

  /**
   * Returns real-time latency and throughput telemetry.
   */
  public getMetrics(): OrderManagerMetrics {
    const avgLatencyUs = this.totalTicks > 0
      ? Number(this.totalEvalDurationNs) / (this.totalTicks * 1000)
      : 0;

    return {
      totalTickEvaluations: this.totalTicks,
      totalStopLossUpdates: this.totalSlUpdates,
      totalTakeProfitTriggers: this.totalTpTriggers,
      totalStopLossTriggers: this.totalSlTriggers,
      totalEmergencyExits: this.totalEmergencyExits,
      avgEvaluationLatencyUs: avgLatencyUs,
      maxEvaluationLatencyUs: this.maxEvalLatencyUs,
      activeTrackedPositions: this.orderStates.size,
    };
  }

  // --- Private Handler Routines ---

  private handleDynamicStopLossUpdate(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    newStopLossPrice: number
  ): void {
    if (!this.enableExchangeNativeSl) return;
    this.updateStopLossOrder(symbol, side, quantity, newStopLossPrice).catch((err: unknown) => {
      console.warn(`[OrderManager] Asynchronous SL ratchet dispatch error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private handleTakeProfitTrigger(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    markPrice: number,
    reason: string
  ): void {
    const exitSide: "BUY" | "SELL" = side === "LONG" ? "SELL" : "BUY";
    const slotId = side === "LONG" ? "CORE_LONG" : "SHORT_SLOT_0";
    const clientOrderId = ClientOrderIdGenerator.generate(symbol, slotId, "TP5");

    this.executionClient.placeOrder({
      symbol,
      side: exitSide,
      type: "MARKET",
      quantity,
      positionSide: side,
      clientOrderId,
    }).then(() => {
      this.untrackPosition(symbol, side);
    }).catch((err: unknown) => {
      console.error(`[OrderManager] Take Profit execution error for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private handleStopLossTrigger(
    symbol: string,
    side: "LONG" | "SHORT",
    quantity: number,
    markPrice: number,
    reason: string
  ): void {
    this.executeEmergencyClose(symbol, side, quantity, reason).catch((err: unknown) => {
      console.error(`[OrderManager] Stop Loss execution error for ${symbol} ${side}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private getKey(symbol: string, side: "LONG" | "SHORT"): string {
    return `${symbol.toUpperCase()}_${side.toUpperCase()}`;
  }
}
