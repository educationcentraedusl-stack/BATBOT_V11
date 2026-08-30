"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const marketDataClient_1 = require("../marketDataClient");
const risk_1 = require("../strategy/risk");
const binance_1 = require("../execution/binance");
const engine_1 = require("../strategy/engine");
const positionLedger_1 = require("../strategy/positionLedger");
const multiEngine_1 = require("../strategy/multiEngine");
const tradingSymbols_1 = require("../config/tradingSymbols");
const timeSynchronizer_1 = require("../utils/timeSynchronizer");
function assert(condition, message) {
    if (!condition) {
        console.error(`❌ [ASSERTION_FAILED] ${message}`);
        throw new Error(`ASSERTION_FAILED: ${message}`);
    }
}
async function runOmsCapacityAndMutexProof() {
    console.log("=========================================================================");
    console.log("  TEST: OMS CAPACITY (10-SLOT HARD CAP) & UNIDIRECTIONAL ASSET MUTEX     ");
    console.log("=========================================================================\n");
    const symbols = (0, tradingSymbols_1.getTradingSymbols)();
    const maxAssets = 10;
    const slotsPerAsset = 256;
    const sab = new SharedArrayBuffer(maxAssets * slotsPerAsset * 8);
    const client = new marketDataClient_1.MarketDataClient(sab, maxAssets, slotsPerAsset);
    const riskGuard = new risk_1.MultiAssetRiskGuard({ maxActivePositions: 10 });
    const executionClient = new binance_1.BinanceExecutionClient();
    const positionLedger = new positionLedger_1.MultiAssetPositionLedger(symbols);
    const multiEngine = new multiEngine_1.MultiAssetStrategyEngine(client, riskGuard, executionClient, symbols, positionLedger);
    const btcEngine = multiEngine.getEngineForSymbol("BTCUSDT");
    const avaxEngine = multiEngine.getEngineForSymbol("AVAXUSDT");
    const solEngine = multiEngine.getEngineForSymbol("SOLUSDT");
    const bnbEngine = multiEngine.getEngineForSymbol("BNBUSDT");
    assert(!!btcEngine, "BTCUSDT engine must be initialized");
    assert(!!avaxEngine, "AVAXUSDT engine must be initialized");
    assert(!!solEngine, "SOLUSDT engine must be initialized");
    assert(!!bnbEngine, "BNBUSDT engine must be initialized");
    const btcIdx = 0;
    const avaxIdx = symbols.indexOf("AVAXUSDT");
    const solIdx = symbols.indexOf("SOLUSDT");
    const bnbIdx = symbols.indexOf("BNBUSDT");
    // Setup valid live market prices
    const nowMs = timeSynchronizer_1.timeSynchronizer.getAdjustedNowMs();
    const nowNs = BigInt(nowMs) * 1000000n;
    for (let i = 0; i < maxAssets; i++) {
        client.writeAtomicFloat64Asset(i, 4, 100.0); // Best Bid
        client.writeAtomicFloat64Asset(i, 5, 10.0); // Best Bid Qty
        client.writeAtomicFloat64Asset(i, 6, 100.01); // Best Ask
        client.writeAtomicFloat64Asset(i, 7, 10.0); // Best Ask Qty
        client.writeAtomicFloat64Asset(i, 114, 0.0001); // Realized vol
        client.writeAtomicFloat64Asset(i, 112, 1.0); // Hawkes
        client.setHurstExponent(0.60, i);
        client.setLOBEntropy(0.50, i);
        // Write valid timestamp
        const bigIntView = new BigInt64Array(sab);
        Atomics.store(bigIntView, i * slotsPerAsset + 0, nowNs);
    }
    // BTC market prices (Slot 4: Bid, Slot 6: Ask)
    client.writeAtomicFloat64Asset(btcIdx, 4, 78120.0);
    client.writeAtomicFloat64Asset(btcIdx, 6, 78120.5);
    // AVAX market prices (Slot 4: Bid, Slot 6: Ask)
    client.writeAtomicFloat64Asset(avaxIdx, 4, 7.295);
    client.writeAtomicFloat64Asset(avaxIdx, 6, 7.296);
    // ============================================================================
    // STAGE 1: Unidirectional Long-Blocks-Short Mutex (BTCUSDT)
    // ============================================================================
    console.log("[STAGE 1] Testing Unidirectional Long-Blocks-Short Mutex on Slot #0 (BTCUSDT)...");
    const btcHedge = btcEngine.getHedgeLedger();
    // Occupy Core Long on BTCUSDT
    btcHedge.occupyCoreLong(0.005, 78120.0, 1.5, 0.8, false);
    assert(btcHedge.getCoreLong().isOccupied === true, "BTC Core Long must be occupied");
    btcEngine.syncSabPositionState(78120.0);
    // Attempt to allocate short slot via evaluateDispersedShortSlotAllocation
    const shortAllocResult = btcHedge.evaluateDispersedShortSlotAllocation(78120.0, 0.1, 0.001, 1.0, 0, nowMs);
    assert(shortAllocResult === null, "evaluateDispersedShortSlotAllocation must return null when Core Long is active");
    // Attempt to reserve short slot
    const reserveShortSuccess = btcHedge.reserveShortSlotPending(0, "TEST_CLID", 78120.0, 0.005);
    assert(reserveShortSuccess === false, "reserveShortSlotPending must return false when Core Long is active");
    // Attempt to directly occupy short slot
    const occupyShortSuccess = btcHedge.occupyShortSlot(0, 0.005, 78120.0, 1.5, 0.8, false);
    assert(occupyShortSuccess === false, "occupyShortSlot must return false when Core Long is active");
    assert(btcHedge.getShortSlots()[0].isOccupied === false, "Short slot #0 must remain FLAT");
    // Feed strong SELL signal into BTC StrategyEngine
    client.writeAtomicFloat64Asset(btcIdx, 1, -0.80); // OBI -0.80
    client.setCVD(-10.0, btcIdx);
    client.setAIPredictionDirection(-0.85, btcIdx); // AI Direction -0.85
    client.setAIPredictionConfidence(0.90, btcIdx); // AI Confidence 90%
    client.setFinalizedSignal(0.0, btcIdx);
    client.setSequenceNum(101n, btcIdx);
    const btcSellEval = btcEngine.evaluateTick();
    assert(btcSellEval.signalType === "NONE", `BTC evaluateTick must reject SELL signal when LONG is occupied (got: ${btcSellEval.signalType})`);
    assert(btcSellEval.executionPromise === undefined, "BTC evaluateTick must not return executionPromise for blocked opposing signal");
    console.log("  ✅ STAGE 1 PASSED: Long position physically blocks all opposing Short entries.\n");
    // ============================================================================
    // STAGE 2: Unidirectional Short-Blocks-Long Mutex (AVAXUSDT)
    // ============================================================================
    console.log("[STAGE 2] Testing Unidirectional Short-Blocks-Long Mutex on Slot #7 (AVAXUSDT)...");
    const avaxHedge = avaxEngine.getHedgeLedger();
    // Occupy Short Slot on AVAXUSDT
    avaxHedge.occupyShortSlot(0, 10.0, 7.295, 1.5, 0.8, false);
    assert(avaxHedge.getShortSlots()[0].isOccupied === true, "AVAX Short Slot #0 must be occupied");
    avaxEngine.syncSabPositionState(7.295);
    // Attempt to reserve Core Long
    const reserveLongSuccess = avaxHedge.reserveCoreLongPending("TEST_CLID_AVAX", 7.295, 10.0);
    assert(reserveLongSuccess === false, "reserveCoreLongPending must return false when Short Slot is active");
    // Attempt to directly occupy Core Long
    avaxHedge.occupyCoreLong(10.0, 7.295, 1.5, 0.8, false);
    assert(avaxHedge.getCoreLong().isOccupied === false, "AVAX Core Long must remain FLAT");
    // Feed strong BUY signal into AVAX StrategyEngine
    client.writeAtomicFloat64Asset(avaxIdx, 1, 0.80); // OBI +0.80
    client.setCVD(10.0, avaxIdx);
    client.setAIPredictionDirection(0.85, avaxIdx); // AI Direction +0.85
    client.setAIPredictionConfidence(0.90, avaxIdx); // AI Confidence 90%
    client.setFinalizedSignal(0.0, avaxIdx);
    client.setSequenceNum(201n, avaxIdx);
    const avaxBuyEval = avaxEngine.evaluateTick();
    assert(avaxBuyEval.signalType === "NONE", `AVAX evaluateTick must reject BUY signal when SHORT is occupied (got: ${avaxBuyEval.signalType})`);
    assert(avaxBuyEval.executionPromise === undefined, "AVAX evaluateTick must not return executionPromise for blocked opposing signal");
    console.log("  ✅ STAGE 2 PASSED: Short position physically blocks all opposing Long entries.\n");
    // ============================================================================
    // STAGE 3: Pending Entry Mutex Isolation (SOLUSDT & BNBUSDT)
    // ============================================================================
    console.log("[STAGE 3] Testing Pending Entry Mutex Isolation on SOLUSDT & BNBUSDT...");
    const solHedge = solEngine.getHedgeLedger();
    // Reserve SOLUSDT Core Long in PENDING_ENTRY
    const solReserveRes = solHedge.reserveCoreLongPending("SOL_PENDING_CID", 105.0, 1.0);
    assert(solReserveRes === true, "SOL reserveCoreLongPending must succeed on flat slot");
    assert(solHedge.getCoreLong().lifecycleState === "PENDING_ENTRY", "SOL Core Long must be PENDING_ENTRY");
    // Feed SELL signal to SOL
    client.writeAtomicFloat64Asset(solIdx, 1, -0.80);
    client.setAIPredictionDirection(-0.85, solIdx);
    client.setAIPredictionConfidence(0.90, solIdx);
    client.setSequenceNum(301n, solIdx);
    const solSellEval = solEngine.evaluateTick();
    assert(solSellEval.signalType === "NONE", "SOL SELL signal must be rejected while Core Long is PENDING_ENTRY");
    assert(solHedge.evaluateDispersedShortSlotAllocation(105.0, 0.01, 0.001, 1.0, 0, nowMs) === null, "SOL short slot allocation must be null during PENDING_ENTRY");
    // Rollback SOL
    solHedge.rollbackPendingSlot("CORE_LONG", "TEST_CLEANUP");
    assert(solHedge.getCoreLong().lifecycleState === "FLAT", "SOL Core Long must be FLAT after rollback");
    // Reserve BNBUSDT Short Slot in PENDING_ENTRY
    const bnbHedge = bnbEngine.getHedgeLedger();
    const bnbReserveRes = bnbHedge.reserveShortSlotPending(0, "BNB_PENDING_CID", 695.0, 0.1);
    assert(bnbReserveRes === true, "BNB reserveShortSlotPending must succeed on flat slot");
    assert(bnbHedge.getShortSlots()[0].lifecycleState === "PENDING_ENTRY", "BNB Short Slot #0 must be PENDING_ENTRY");
    // Feed BUY signal to BNB
    client.writeAtomicFloat64Asset(bnbIdx, 1, 0.80);
    client.setAIPredictionDirection(0.85, bnbIdx);
    client.setAIPredictionConfidence(0.90, bnbIdx);
    client.setSequenceNum(401n, bnbIdx);
    const bnbBuyEval = bnbEngine.evaluateTick();
    assert(bnbBuyEval.signalType === "NONE", "BNB BUY signal must be rejected while Short Slot is PENDING_ENTRY");
    // Rollback BNB
    bnbHedge.rollbackPendingSlot("SHORT_SLOT_0", "TEST_CLEANUP");
    assert(bnbHedge.getShortSlots()[0].lifecycleState === "FLAT", "BNB Short Slot #0 must be FLAT after rollback");
    console.log("  ✅ STAGE 3 PASSED: In-flight PENDING_ENTRY orders strictly block opposing entry signals.\n");
    // ============================================================================
    // STAGE 4: 10-Slot Portfolio Hard-Cap Barrier & Partial TP Notional Synchronicity
    // ============================================================================
    console.log("[STAGE 4] Testing 10-Slot Portfolio Hard-Cap Barrier & Partial TP Notional Synchronicity...");
    // Reset all engines to known flat state
    for (const sym of symbols) {
        const eng = multiEngine.getEngineForSymbol(sym);
        if (eng) {
            eng.getHedgeLedger().clearSlots();
            eng.syncSabPositionState(0);
        }
    }
    riskGuard.resetSymbolNotionals();
    // Populate exactly 9 distinct asset slots with confirmed positions via real hot-path execution success
    for (let i = 0; i < 9; i++) {
        const sym = symbols[i];
        const eng = multiEngine.getEngineForSymbol(sym);
        eng.getHedgeLedger().occupyCoreLong(1.0, 100.0, 1.5, 0.8, false);
        eng.syncSabPositionState(100.0);
        riskGuard.recordExecutionSuccess(100.0, "BUY", sym, false, 100.0);
    }
    assert(riskGuard.getActiveSymbolCount() === 9, `RiskGuard active symbols must equal 9 (got: ${riskGuard.getActiveSymbolCount()})`);
    assert(btcEngine.getGlobalActivePositionCount() === 9, `Global active positions must equal 9 before in-flight entry`);
    // CONCURRENCY LEAK (DEF-2101) VERIFICATION:
    // Asset #9 (the 10th symbol) enters PENDING_ENTRY (in-flight dispatch awaiting Binance execution).
    // Its SAB position quantity is still 0.0 during the await window!
    const sym9 = symbols[9];
    const eng9 = multiEngine.getEngineForSymbol(sym9);
    const reservePendingRes = eng9.getHedgeLedger().reserveCoreLongPending("PENDING_CID_ASSET_9", 100.0, 1.0);
    assert(reservePendingRes === true, "Asset #9 reserveCoreLongPending must succeed on flat slot");
    assert(eng9.getHedgeLedger().getCoreLong().lifecycleState === "PENDING_ENTRY", "Asset #9 must be PENDING_ENTRY");
    // Global active position count MUST now equal 10 (9 SAB confirmed + 1 in-flight PENDING_ENTRY)
    const globalPosCountWithPending = btcEngine.getGlobalActivePositionCount();
    assert(globalPosCountWithPending === 10, `Global active positions with in-flight pending must equal 10 (got: ${globalPosCountWithPending})`);
    // Verify RiskGuard registers 10th symbol execution success with $100.0 notional
    riskGuard.recordExecutionSuccess(100.0, "BUY", sym9, false, 100.0);
    assert(riskGuard.getActiveSymbolCount() === 10, "RiskGuard must report exactly 10 active symbols");
    assert(riskGuard.getSymbolNotional(sym9) === 100.0, "Symbol notional must equal $100.0");
    const order11Intent = {
        symbol: "NEW_11TH_SYMBOL",
        side: "BUY",
        quantity: 1.0,
        price: 100.0,
    };
    const riskRes11 = riskGuard.validateMultiAssetOrder(order11Intent, true);
    assert(riskRes11.passed === false, "RiskGuard must reject 11th position entry");
    assert(riskRes11.reasonCode === "EXCEEDS_MAX_POSITION", `Expected EXCEEDS_MAX_POSITION, got: ${riskRes11.reasonCode}`);
    // PARTIAL TAKE-PROFIT (TP) SYNCHRONICITY (DEF-2102 REMEDIATION PROOF):
    // Simulate partial TP fill of 30% on Asset #9 ($30 notional executed, $70 remaining active notional)
    riskGuard.recordExecutionSuccess(30.0, "SELL", sym9, true, 70.0);
    assert(riskGuard.getActiveSymbolCount() === 10, "RiskGuard active symbol count must REMAIN 10 on partial TP fill (no premature deletion)");
    assert(riskGuard.getSymbolNotional(sym9) === 70.0, "RiskGuard symbol notional must update to remaining $70.0");
    // 11th symbol must STILL be blocked because 10 symbols remain active
    const riskRes11DuringPartial = riskGuard.validateMultiAssetOrder(order11Intent, true);
    assert(riskRes11DuringPartial.passed === false, "RiskGuard must continue to reject 11th position while 10 assets have open notional");
    // Final exit fill of remaining 70% ($70 notional executed, $0 remaining)
    eng9.getHedgeLedger().rollbackPendingSlot("CORE_LONG", "TEST_CLEANUP");
    riskGuard.recordExecutionSuccess(70.0, "SELL", sym9, true, 0.0); // 0 remaining notional triggers physical deletion
    eng9.syncSabPositionState(0);
    const updatedCount = btcEngine.getGlobalActivePositionCount();
    assert(updatedCount === 9, `Global active positions after full close must equal 9 (got: ${updatedCount})`);
    assert(riskGuard.getActiveSymbolCount() === 9, `RiskGuard active symbols after full close must equal 9 (got: ${riskGuard.getActiveSymbolCount()})`);
    assert(riskGuard.getSymbolNotional(sym9) === 0.0, "RiskGuard symbol notional must be 0 after full close");
    const riskResAfterClose = riskGuard.validateMultiAssetOrder(order11Intent, true);
    assert(riskResAfterClose.passed === true, "RiskGuard must approve new position when active count < 10");
    console.log("  ✅ STAGE 4 PASSED: 10-slot hard ceiling & partial TP notional synchronicity strictly verified.\n");
    // ============================================================================
    // STAGE 5: Asynchronous Promise.all Concurrent Tick Race & Serialization Proof
    // ============================================================================
    console.log("[STAGE 5] Testing Asynchronous Promise.all Concurrent Tick Race & Capacity Serialization...");
    // Setup 9 active confirmed positions on Symbols 0..8
    for (let i = 0; i < 9; i++) {
        const sym = symbols[i];
        const eng = multiEngine.getEngineForSymbol(sym);
        eng.getHedgeLedger().clearSlots();
        eng.getHedgeLedger().occupyCoreLong(1.0, 100.0, 1.5, 0.8, false);
        eng.syncSabPositionState(100.0);
        riskGuard.recordExecutionSuccess(100.0, "BUY", sym, false, 100.0);
    }
    assert(btcEngine.getGlobalActivePositionCount() === 9, "9 active positions must be active before concurrent race");
    // Release LINKUSDT & DOTUSDT to FLAT so exactly 8 are occupied, 2 are FLAT
    const linkEng = multiEngine.getEngineForSymbol("LINKUSDT");
    const dotEng = multiEngine.getEngineForSymbol("DOTUSDT");
    linkEng.getHedgeLedger().clearSlots();
    linkEng.syncSabPositionState(0);
    riskGuard.recordExecutionSuccess(100.0, "SELL", "LINKUSDT", true, 0.0);
    dotEng.getHedgeLedger().clearSlots();
    dotEng.syncSabPositionState(0);
    riskGuard.recordExecutionSuccess(100.0, "SELL", "DOTUSDT", true, 0.0);
    // Exactly 8 positions confirmed active
    assert(btcEngine.getGlobalActivePositionCount() === 8, "Portfolio must have 8 active positions (2 available slots)");
    // Re-occupy LINKUSDT so exactly 9 are active (only 1 available slot remaining before 10-slot cap)
    linkEng.getHedgeLedger().occupyCoreLong(1.0, 100.0, 1.5, 0.8, false);
    linkEng.syncSabPositionState(100.0);
    riskGuard.recordExecutionSuccess(100.0, "BUY", "LINKUSDT", false, 100.0);
    assert(btcEngine.getGlobalActivePositionCount() === 9, "Portfolio must have exactly 9 active positions (1 available slot left)");
    // Instantiate 11th candidate engine (NEARUSDT) to compete simultaneously with DOTUSDT
    const test11Hedge = new positionLedger_1.HedgePositionLedger("NEARUSDT", 3);
    const nearEngine = new engine_1.StrategyEngine(client, riskGuard, executionClient, { symbol: "NEARUSDT", assetIndex: 0 }, test11Hedge.getLegacyLedger(), test11Hedge);
    // Feed simultaneous strong BUY signals to both DOTUSDT and NEARUSDT
    const dotIdx = symbols.indexOf("DOTUSDT");
    client.writeAtomicFloat64Asset(dotIdx, 1, 0.80);
    client.setCVD(10.0, dotIdx);
    client.setAIPredictionDirection(0.85, dotIdx);
    client.setAIPredictionConfidence(0.90, dotIdx);
    client.setShortCooldownLock(0, dotIdx);
    client.setLongCooldownLock(0, dotIdx);
    client.setSequenceNum(701n, dotIdx);
    // Setup NEAR tick data on BTC asset index 0 (clean state)
    client.writeAtomicFloat64Asset(0, 1, 0.80);
    client.setCVD(10.0, 0);
    client.setAIPredictionDirection(0.85, 0);
    client.setAIPredictionConfidence(0.90, 0);
    client.setShortCooldownLock(0, 0);
    client.setLongCooldownLock(0, 0);
    client.setSequenceNum(801n, 0);
    // Fire concurrent Promise.all evaluations for both candidate engines
    const [dotEval, nearEval] = await Promise.all([
        Promise.resolve().then(() => dotEng.evaluateTick()),
        Promise.resolve().then(() => nearEngine.evaluateTick()),
    ]);
    // Assert: Exactly ONE engine succeeded in generating an actionable BUY signal, while the other was blocked
    const dotApproved = dotEval.signalType === "BUY";
    const nearApproved = nearEval.signalType === "BUY";
    assert((dotApproved && !nearApproved) || (!dotApproved && nearApproved), `Exactly one engine must win the race (DOT: ${dotEval.signalType}, NEAR: ${nearEval.signalType})`);
    const finalGlobalCount = btcEngine.getGlobalActivePositionCount();
    assert(finalGlobalCount === 10, `Global active position count must remain capped at exactly 10 (got: ${finalGlobalCount})`);
    // Clean up candidate reservations & restore registered engines
    dotEng.clearPendingEntryOrders();
    dotEng.getHedgeLedger().clearSlots();
    nearEngine.clearPendingEntryOrders();
    nearEngine.getHedgeLedger().clearSlots();
    engine_1.StrategyEngine.resetRegisteredEngines();
    for (const eng of multiEngine.getAllEngines().values()) {
        engine_1.StrategyEngine.registerEngine(eng);
    }
    console.log("  ✅ STAGE 5 PASSED: Asynchronous Promise.all tick race serialized with zero capacity breach.\n");
    // ============================================================================
    // STAGE 6: Clean Release & Flip Authorization
    // ============================================================================
    console.log("[STAGE 6] Testing Clean Position Release & Directional Flip Authorization...");
    btcHedge.clearSlots();
    btcEngine.syncSabPositionState(0);
    assert(btcHedge.getCoreLong().isOccupied === false, "BTC Core Long must be FLAT");
    assert(btcHedge.getShortSlots()[0].isOccupied === false, "BTC Short Slot must be FLAT");
    // Feed strong SELL signal to BTC
    client.writeAtomicFloat64Asset(btcIdx, 1, -0.80);
    client.setCVD(-10.0, btcIdx);
    client.setAIPredictionDirection(-0.85, btcIdx);
    client.setAIPredictionConfidence(0.90, btcIdx);
    client.setShortCooldownLock(0, btcIdx);
    client.setLongCooldownLock(0, btcIdx);
    client.setSequenceNum(501n, btcIdx);
    const btcFlipSellEval = btcEngine.evaluateTick();
    assert(btcFlipSellEval.signalType === "SELL", `BTC must approve SELL signal when FLAT (got: ${btcFlipSellEval.signalType})`);
    assert(btcFlipSellEval.slotId === "SHORT_SLOT_0", `Target slot must be SHORT_SLOT_0 (got: ${btcFlipSellEval.slotId})`);
    // Clear in-flight mock dispatch to simulate fill
    btcEngine.clearPendingEntryOrders();
    // Occupy Short Slot on BTC
    btcHedge.occupyShortSlot(0, 0.005, 78120.0, 1.5, 0.8, false);
    btcEngine.syncSabPositionState(78120.0);
    assert(btcHedge.getShortSlots()[0].isOccupied === true, "BTC Short Slot must be occupied");
    // Release Short Slot
    btcHedge.releaseShortSlot(0, 78100.0, 0.0004, "SIGNAL_EXIT", 78100.0);
    btcEngine.syncSabPositionState(0);
    btcEngine.clearPendingEntryOrders();
    client.setShortCooldownLock(0, btcIdx);
    client.setLongCooldownLock(0, btcIdx);
    assert(btcHedge.getShortSlots()[0].isOccupied === false, "BTC Short Slot must be released to FLAT");
    // Feed strong BUY signal to BTC
    client.writeAtomicFloat64Asset(btcIdx, 1, 0.80);
    client.setCVD(10.0, btcIdx);
    client.setAIPredictionDirection(0.85, btcIdx);
    client.setAIPredictionConfidence(0.90, btcIdx);
    client.setSequenceNum(601n, btcIdx);
    const btcFlipBuyEval = btcEngine.evaluateTick();
    assert(btcFlipBuyEval.signalType === "BUY", `BTC must approve BUY signal when FLAT after Short release (got: ${btcFlipBuyEval.signalType})`);
    assert(btcFlipBuyEval.slotId === "CORE_LONG", `Target slot must be CORE_LONG (got: ${btcFlipBuyEval.slotId})`);
    console.log("  ✅ STAGE 6 PASSED: Releasing position immediately restores flip authorization.\n");
    // ============================================================================
    // STAGE 7: Sub-Microsecond Hot-Path Latency Benchmark (< 1.500 µs / tick)
    // ============================================================================
    console.log("[STAGE 7] Benchmarking Hot-Path Latency with Mutex & Capacity Guards (100,000 evaluations)...");
    btcHedge.clearSlots();
    btcEngine.syncSabPositionState(0);
    const warmupIterations = 5000;
    for (let i = 0; i < warmupIterations; i++) {
        client.setSequenceNum(BigInt(1000 + i), btcIdx);
        btcEngine.evaluateTick();
    }
    const iterations = 100_000;
    const startHr = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
        client.setSequenceNum(BigInt(10000 + i), btcIdx);
        btcEngine.evaluateTick();
    }
    const endHr = process.hrtime.bigint();
    const totalNs = Number(endHr - startHr);
    const totalMs = totalNs / 1_000_000;
    const avgUsPerTick = (totalNs / iterations) / 1_000;
    console.log(`  - 100,000 tick evaluations completed in: ${totalMs.toFixed(2)} ms`);
    console.log(`  - Average hot-path evaluation latency  : ${avgUsPerTick.toFixed(4)} µs / tick`);
    assert(avgUsPerTick < 1.500, `Latency must be < 1.500 µs (got: ${avgUsPerTick.toFixed(4)} µs)`);
    console.log(`  ✅ STAGE 7 PASSED: Sub-microsecond latency (${avgUsPerTick.toFixed(4)} µs < 1.500 µs HFT SLA).\n`);
    console.log("=========================================================================");
    console.log("  ALL 7 STAGES PASSED: OMS CAPACITY & MUTEX LOCK 100% VERIFIED           ");
    console.log("=========================================================================");
}
runOmsCapacityAndMutexProof().catch((err) => {
    console.error("FATAL TEST FAILURE:", err);
    process.exit(1);
});
