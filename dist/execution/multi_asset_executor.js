"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAssetExecutor = void 0;
require("dotenv/config");
const index_1 = require("../../index");
const binance_1 = require("./binance");
const userDataStream_1 = require("./userDataStream");
class MultiAssetExecutor {
    initialBalanceUsd;
    activeSymbols;
    symbolToIdxMap = new Map();
    client;
    userStream;
    isRunning = false;
    constructor(config) {
        this.initialBalanceUsd = config.initialBalanceUsd;
        this.activeSymbols = config.activeSymbols.slice(0, 10);
        this.activeSymbols.forEach((sym, idx) => {
            this.symbolToIdxMap.set(sym, idx);
        });
        this.client = new binance_1.BinanceExecutionClient(config.clientOptions);
        this.userStream = new userDataStream_1.BinanceUserDataStream(this.client);
        // Initialize Rust Native MultiAssetOmsEngine
        (0, index_1.startMultiAssetOmsNapi)(this.initialBalanceUsd, JSON.stringify(this.activeSymbols));
    }
    async start() {
        if (this.isRunning)
            return true;
        // Subscribe to Binance User Data Stream for live order updates
        this.userStream.subscribeOrderUpdates((update) => {
            this.handleUserStreamUpdate(update);
        });
        await this.userStream.start();
        this.isRunning = true;
        return true;
    }
    stop() {
        this.userStream.stop();
        this.isRunning = false;
    }
    getAssetIndex(symbol) {
        const idx = this.symbolToIdxMap.get(symbol);
        if (idx === undefined) {
            throw new Error(`[MultiAssetExecutor] Unmapped symbol '${symbol}' not found in activeSymbols`);
        }
        return idx;
    }
    submitIntent(symbol, side, orderType, quantity, price, midPrice, top5DepthUsd, stepSize = 0.001, tickSize = 0.01, portfolioLeverage = 0.0, avgCorrelation = 0.0, options) {
        const assetIdx = this.getAssetIndex(symbol);
        const isMarket = orderType === "MARKET";
        const postOnly = isMarket ? false : (options?.postOnly ?? true);
        const timeInForce = isMarket ? "Ioc" : (options?.timeInForce ?? "Gtx");
        const targetHorizonMs = options?.targetHorizonMs ?? 100.0;
        const aiConfidence = options?.aiConfidence ?? 0.85;
        const reduceOnly = options?.reduceOnly ?? false;
        const creationNs = Number(process.hrtime.bigint());
        const intentPayload = {
            client_order_id: `BAT_${assetIdx}_${Date.now()}`,
            symbol,
            asset_idx: assetIdx,
            side: side === "BUY" ? "Buy" : "Sell",
            order_type: isMarket ? "Market" : "Limit",
            time_in_force: timeInForce,
            quantity,
            price,
            reduce_only: reduceOnly,
            post_only: postOnly,
            target_horizon_ms: targetHorizonMs,
            ai_confidence: aiConfidence,
            ai_direction: side === "BUY" ? 1.0 : -1.0,
            creation_ns: creationNs,
        };
        const intentJson = JSON.stringify(intentPayload);
        try {
            const resStr = (0, index_1.submitMultiAssetIntentNapi)(assetIdx, intentJson, midPrice, top5DepthUsd, stepSize, tickSize, portfolioLeverage, avgCorrelation);
            if (resStr.startsWith('{"status":"REJECTED"')) {
                const parsed = JSON.parse(resStr);
                return { status: "REJECTED", reason: parsed.reason };
            }
            else {
                const slices = JSON.parse(resStr);
                return { status: "SUBMITTED", slices };
            }
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return { status: "REJECTED", reason: errorMsg };
        }
    }
    popNextPacket() {
        try {
            const pktStr = (0, index_1.popNextIntentPacketNapi)();
            if (!pktStr)
                return null;
            return JSON.parse(pktStr);
        }
        catch (err) {
            console.error("[MultiAssetExecutor] Failed to pop intent packet:", err);
            return null;
        }
    }
    syncSab(sabBuffer) {
        return (0, index_1.syncMultiOmsSabNapi)(sabBuffer);
    }
    getMetrics(symbol) {
        const assetIdx = this.getAssetIndex(symbol);
        const metricsStr = (0, index_1.getMultiAssetOmsMetricsNapi)(assetIdx);
        try {
            const raw = JSON.parse(metricsStr);
            return {
                assetIdx: raw.asset_idx ?? assetIdx,
                symbol,
                totalOrdersSubmitted: raw.total_orders_submitted ?? 0,
                totalOrdersFilled: raw.total_orders_filled ?? 0,
                totalOrdersCanceled: raw.total_orders_canceled ?? 0,
                totalOrdersRejected: raw.total_orders_rejected ?? 0,
                totalVolumeUsd: raw.total_volume_usd ?? 0,
                realizedPnlUsd: raw.realized_pnl_usd ?? 0,
                unrealizedPnlUsd: raw.unrealized_pnl_usd ?? 0,
                currentPositionSize: raw.current_position_size ?? 0,
                avgEntryPrice: raw.avg_entry_price ?? 0,
            };
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            throw new Error(`[MultiAssetExecutor] Failed to parse metrics for ${symbol}: ${errorMsg}`);
        }
    }
    handleUserStreamUpdate(update) {
        if (!update || update.eventType !== "ORDER_TRADE_UPDATE")
            return;
        try {
            const ord = update.order;
            const assetIdx = this.getAssetIndex(ord.symbol);
            const reportJson = JSON.stringify({
                client_order_id: ord.clientOrderId,
                order_id: ord.orderId,
                symbol: ord.symbol,
                asset_idx: assetIdx,
                side: ord.side === "BUY" ? "Buy" : "Sell",
                status: ord.orderStatus,
                last_filled_qty: ord.lastFilledQuantity,
                last_filled_price: ord.lastFilledPrice,
                cum_filled_qty: ord.cumulativeFilledQuantity,
                avg_price: ord.averagePrice,
                commission: ord.commissionAmount,
                commission_asset: ord.commissionAsset,
                trade_id: ord.tradeId,
                event_time_ns: ord.tradeTime * 1_000_000,
                is_maker: ord.isMaker,
            });
            (0, index_1.applyMultiAssetFillNapi)(reportJson);
        }
        catch (err) {
            console.error("[MultiAssetExecutor] Error in user stream fill update processing:", err);
        }
    }
}
exports.MultiAssetExecutor = MultiAssetExecutor;
