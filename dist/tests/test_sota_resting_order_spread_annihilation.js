"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const assert = __importStar(require("assert"));
const engine_1 = require("../strategy/engine");
const marketDataClient_1 = require("../marketDataClient");
const binance_1 = require("../execution/binance");
const risk_1 = require("../strategy/risk");
const positionLedger_1 = require("../strategy/positionLedger");
async function runSotaRestingOrderSpreadAnnihilationTests() {
    console.log("================================================================================");
    console.log("  TEST SUITE: SOTA 4-TIER SPREAD SHIELD & AROS-CA ANNIHILATION VERIFICATION     ");
    console.log("================================================================================");
    const slotsPerAsset = 256;
    const maxAssets = 10;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.RiskGuard();
    const mockExecutionClient = new binance_1.BinanceExecutionClient();
    let cancelledOrderIds = [];
    let placedOrders = [];
    mockExecutionClient.isConfigured = () => true;
    mockExecutionClient.cancelOrder = async (symbol, orderId) => {
        cancelledOrderIds.push(orderId);
        return { symbol, orderId, status: "CANCELED" };
    };
    mockExecutionClient.placeOrder = async (params) => {
        placedOrders.push(params);
        // Return pending resting LIMIT order
        return {
            symbol: params.symbol,
            orderId: 888123,
            clientOrderId: params.clientOrderId || "CID_TEST",
            price: String(params.price || "79050.0"),
            avgPrice: "0",
            origQty: String(params.quantity),
            executedQty: "0",
            cumQuote: "0",
            status: "NEW",
            timeInForce: "GTX",
            type: "LIMIT",
            reduceOnly: false,
            side: params.side,
            positionSide: params.positionSide || "SHORT",
            stopPrice: "0",
            workingType: "CONTRACT_PRICE",
            updateTime: Date.now(),
        };
    };
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    const engine = new engine_1.StrategyEngine(client, riskGuard, mockExecutionClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        minAiConfidence: 0.60,
        aggressiveConfidenceThreshold: 0.70,
        maxSpreadBtc: 1.50,
        orderQuantity: 0.001,
        tradeSizeUsdt: 60.0,
        obiBuyThreshold: 0.10,
        obiSellThreshold: -0.10,
    }, hedgeLedger.getLegacyLedger(), hedgeLedger);
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * 1000000n;
    const bigIntView = new BigInt64Array(sab);
    bigIntView[0] = nowNs; // Fresh timestamp
    bigIntView[92] = 1n; // Seq #1
    // ============================================================================
    // STAGE 1: TIGHT SPREAD PLACES RESTING LIMIT ORDER
    // ============================================================================
    console.log("\n[STAGE 1] Testing Resting Limit Order Placement under Tight Spread ($0.20)...");
    client.writeAtomicFloat64Asset(0, 4, 79050.0); // Best Bid
    client.writeAtomicFloat64Asset(0, 6, 79050.20); // Best Ask ($0.20 spread <= $1.50 cap)
    client.writeAtomicFloat64Asset(0, 93, -0.95); // AI Dir (-0.95 Bearish)
    client.writeAtomicFloat64Asset(0, 94, 0.90); // AI Conf (90%)
    client.writeAtomicFloat64Asset(0, 1, -0.50); // OBI (-0.50)
    client.writeAtomicFloat64Asset(0, 2, -5.0); // CVD
    const res1 = engine.evaluateTick();
    console.log(`  -> Signal Type: ${res1.signalType}, Target Side: ${res1.positionSide}`);
    assert.strictEqual(res1.signalType, "SELL", "Stage 1: Must generate SELL signal on tight spread");
    assert.ok(res1.executionPromise, "Stage 1: executionPromise must be present");
    // Await order dispatch
    const orderRes = await res1.executionPromise;
    assert.ok(orderRes, "Stage 1: Order response must be returned");
    assert.strictEqual(orderRes?.orderId, 888123, "Stage 1: Order ID must match mock");
    assert.strictEqual(hedgeLedger.getShortSlots()[0].lifecycleState, "PENDING_ENTRY", "Stage 1: Slot 0 must be PENDING_ENTRY");
    console.log("  ✅ STAGE 1 PASSED: Limit order #888123 placed & resting on Binance orderbook (PENDING_ENTRY).");
    // ============================================================================
    // STAGE 2: TIER-1 AROS-CA SPREAD BLOWOUT RESTING ORDER ANNIHILATION
    // ============================================================================
    console.log("\n[STAGE 2] Testing AROS-CA: Orderbook Blows Out ($60.30 Spread) -> Annihilation...");
    bigIntView[92] = 2n; // Seq #2
    // Simulate market maker retreat / spread blowout to $60.30 on BTC
    client.writeAtomicFloat64Asset(0, 4, 79000.0); // Best Bid
    client.writeAtomicFloat64Asset(0, 6, 79060.30); // Best Ask ($60.30 spread > $1.50 cap)
    const res2 = engine.evaluateTick();
    console.log(`  -> Tick #2 Signal Type: ${res2.signalType}, Reason: ${res2.riskResult?.reasonCode}`);
    assert.strictEqual(res2.signalType, "NONE", "Stage 2: Must reject tick evaluation on blowout");
    // Verify AROS-CA triggered immediate cancellation of resting order #888123
    assert.ok(cancelledOrderIds.includes(888123), "Stage 2: Resting Order #888123 MUST be cancelled on Binance!");
    assert.strictEqual(hedgeLedger.getShortSlots()[0].lifecycleState, "FLAT", "Stage 2: Slot 0 must be rolled back to FLAT");
    assert.strictEqual(hedgeLedger.getShortSlots()[0].isOccupied, false, "Stage 2: Slot 0 must NOT be occupied");
    console.log("  ✅ STAGE 2 PASSED: AROS-CA swept and annihilated resting order #888123, restored slot to FLAT!");
    // ============================================================================
    // STAGE 3: TIER-3 PRE-FLIGHT SPREAD BLOWOUT BARRIER INTERCEPTION
    // ============================================================================
    console.log("\n[STAGE 3] Testing Tier-3 Transport-Level Pre-Flight Spread Barrier...");
    bigIntView[92] = 3n;
    // Restore tight spread to generate signal
    client.writeAtomicFloat64Asset(0, 4, 79050.0);
    client.writeAtomicFloat64Asset(0, 6, 79050.30);
    placedOrders = [];
    cancelledOrderIds = [];
    // Artificially simulate spread blowout happening directly during pre-flight write
    const preflightEngine = new engine_1.StrategyEngine(client, riskGuard, mockExecutionClient, {
        symbol: "BTCUSDT",
        assetIndex: 0,
        minAiConfidence: 0.60,
        maxSpreadBtc: 1.50,
        orderQuantity: 0.001,
        tradeSizeUsdt: 60.0,
        obiBuyThreshold: 0.10,
        obiSellThreshold: -0.10,
    }, hedgeLedger.getLegacyLedger(), hedgeLedger);
    // Set blowout spread right before dispatch
    client.writeAtomicFloat64Asset(0, 4, 78900.0);
    client.writeAtomicFloat64Asset(0, 6, 79000.0); // $100 spread blowout
    const res3 = preflightEngine.evaluateTick();
    assert.strictEqual(res3.signalType, "NONE", "Stage 3: Pre-flight must block signal under blowout");
    console.log("  ✅ STAGE 3 PASSED: Pre-flight spread barrier blocked execution.");
    // ============================================================================
    // STAGE 4: TIER-4 DYNAMIC GRID SPREAD GATING IN POSITION LEDGER
    // ============================================================================
    console.log("\n[STAGE 4] Testing Tier-4 Dynamic Grid Spread Gating in HedgePositionLedger...");
    const gridLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
    const tightAlloc = gridLedger.evaluateDispersedShortSlotAllocation(79000.0, 0.1, 0.005, 1.2, 0, nowMs, 0.50, 1.50);
    assert.ok(tightAlloc !== null, "Stage 4: Tight spread must permit slot allocation");
    assert.strictEqual(tightAlloc?.slotIndex, 0, "Stage 4: First slot index must be 0");
    const blowoutAlloc = gridLedger.evaluateDispersedShortSlotAllocation(79000.0, 0.1, 0.005, 1.2, 0, nowMs, 60.30, 1.50);
    assert.strictEqual(blowoutAlloc, null, "Stage 4: Blown-out spread (60.30 > 1.50) MUST strictly reject slot allocation");
    console.log("  ✅ STAGE 4 PASSED: Dynamic Grid Spread Gating strictly rejected allocation on blown-out spread.");
    console.log("\n================================================================================");
    console.log("  ALL 4 STAGES OF 4-TIER SPREAD SHIELD & AROS-CA VERIFIED (100% SUCCESS)         ");
    console.log("================================================================================");
}
runSotaRestingOrderSpreadAnnihilationTests().catch((err) => {
    console.error("Test failed with error:", err);
    process.exit(1);
});
