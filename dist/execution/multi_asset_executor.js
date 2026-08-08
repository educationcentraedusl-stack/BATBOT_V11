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
    symbolBuffers = [];
    client;
    userStream;
    isRunning = false;
    pktBuf = Buffer.allocUnsafe(128);
    constructor(config) {
        this.initialBalanceUsd = config.initialBalanceUsd;
        this.activeSymbols = config.activeSymbols.slice(0, 10);
        this.activeSymbols.forEach((sym, idx) => {
            this.symbolToIdxMap.set(sym, idx);
            const symBuf = Buffer.alloc(16);
            symBuf.write(sym, 0, 16, "utf8");
            this.symbolBuffers.push(symBuf);
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
        const tifStr = isMarket ? "Ioc" : (options?.timeInForce ?? "Gtx");
        const targetHorizonMs = options?.targetHorizonMs ?? 100.0;
        const aiConfidence = options?.aiConfidence ?? 0.85;
        const reduceOnly = options?.reduceOnly ?? false;
        // Zero-copy 128-byte Buffer packing (OrderIntentPacket layout)
        const pktBuf = this.pktBuf;
        pktBuf.fill(0);
        pktBuf.writeUInt32LE(assetIdx, 0);
        pktBuf.writeUInt8(side === "BUY" ? 0 : 1, 4);
        pktBuf.writeUInt8(isMarket ? 1 : 0, 5);
        let tifCode = 3;
        if (tifStr === "Gtc")
            tifCode = 0;
        else if (tifStr === "Ioc")
            tifCode = 1;
        else if (tifStr === "Fok")
            tifCode = 2;
        pktBuf.writeUInt8(tifCode, 6);
        let flags = 0;
        if (reduceOnly)
            flags |= 1 << 0;
        if (postOnly)
            flags |= 1 << 1;
        pktBuf.writeUInt8(flags, 7);
        pktBuf.writeDoubleLE(quantity, 8);
        pktBuf.writeDoubleLE(price, 16);
        pktBuf.writeFloatLE(targetHorizonMs, 24);
        pktBuf.writeFloatLE(aiConfidence, 28);
        pktBuf.writeFloatLE(side === "BUY" ? 1.0 : -1.0, 32);
        pktBuf.writeUInt32LE(0, 36);
        // Copy pre-allocated symbol buffer
        pktBuf.set(this.symbolBuffers[assetIdx], 112);
        try {
            const resBuf = (0, index_1.submitMultiAssetIntentBytesNapi)(pktBuf, midPrice, top5DepthUsd, stepSize, tickSize, portfolioLeverage, avgCorrelation);
            if (resBuf.length === 2 && resBuf[0] === 0xff) {
                const reasonCode = resBuf[1];
                const reasonMap = {
                    1: "REJECTED_RATE_LIMIT",
                    2: "REJECTED_PRICE_COLLAR",
                    3: "REJECTED_LEVERAGE_CAP",
                    4: "REJECTED_CORRELATION_SPIKE",
                    5: "REJECTED_INVALID_QTY_PRICE",
                };
                return { status: "REJECTED", reason: reasonMap[reasonCode] || "REJECTED_UNKNOWN" };
            }
            const numSlices = Math.floor(resBuf.length / 128);
            const slices = [];
            for (let i = 0; i < numSlices; i++) {
                slices.push(this.parsePacketFromBuffer(resBuf, i * 128));
            }
            return { status: "SUBMITTED", slices };
        }
        catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            return { status: "REJECTED", reason: errorMsg };
        }
    }
    popNextPacket() {
        try {
            const pktBuf = (0, index_1.popNextIntentPacketBytesNapi)();
            if (!pktBuf || pktBuf.length < 128)
                return null;
            return this.parsePacketFromBuffer(pktBuf, 0);
        }
        catch (err) {
            console.error("[MultiAssetExecutor] Failed to pop intent packet:", err);
            return null;
        }
    }
    parsePacketFromBuffer(buf, offset) {
        const assetIdx = buf.readUInt32LE(offset + 0);
        const sideCode = buf.readUInt8(offset + 4);
        const orderTypeCode = buf.readUInt8(offset + 5);
        const tifCode = buf.readUInt8(offset + 6);
        const flags = buf.readUInt8(offset + 7);
        const quantity = buf.readDoubleLE(offset + 8);
        const price = buf.readDoubleLE(offset + 16);
        const targetHorizonMs = buf.readFloatLE(offset + 24);
        const aiConfidence = buf.readFloatLE(offset + 28);
        const aiDirection = buf.readFloatLE(offset + 32);
        const creationNs = buf.readBigUInt64LE(offset + 40);
        let cidLen = 0;
        while (cidLen < 64 && buf[offset + 48 + cidLen] !== 0)
            cidLen++;
        const clientOrderId = buf.toString("utf8", offset + 48, offset + 48 + cidLen);
        let symLen = 0;
        while (symLen < 16 && buf[offset + 112 + symLen] !== 0)
            symLen++;
        const symbol = buf.toString("utf8", offset + 112, offset + 112 + symLen);
        const tifMap = ["Gtc", "Ioc", "Fok", "Gtx"];
        return {
            client_order_id: clientOrderId,
            symbol,
            asset_idx: assetIdx,
            side: sideCode === 0 ? "Buy" : "Sell",
            order_type: orderTypeCode === 1 ? "Market" : "Limit",
            time_in_force: tifMap[tifCode] || "Gtx",
            quantity,
            price,
            reduce_only: (flags & (1 << 0)) !== 0,
            post_only: (flags & (1 << 1)) !== 0,
            target_horizon_ms: targetHorizonMs,
            ai_confidence: aiConfidence,
            ai_direction: aiDirection,
            creation_ns: Number(creationNs),
        };
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
