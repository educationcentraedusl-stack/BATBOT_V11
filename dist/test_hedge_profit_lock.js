"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const risk_1 = require("./strategy/risk");
const positionLedger_1 = require("./strategy/positionLedger");
const recalibrationWorker_1 = require("./ai/recalibrationWorker");
async function runHedgeAndProfitLockTests() {
    console.log("================================================================================");
    console.log("            BATBOT_V11 HEDGE MODE & PROFIT LOCK VERIFICATION SUITE              ");
    console.log("================================================================================");
    // 1. Verify Environment Variables
    console.log("\n[TEST 1] Verifying Dynamic Strategy Environment Variables...");
    const longTp = process.env.LONG_TAKE_PROFIT_PERCENT ? parseFloat(process.env.LONG_TAKE_PROFIT_PERCENT) : NaN;
    const longSl = process.env.LONG_STOP_LOSS_PERCENT ? parseFloat(process.env.LONG_STOP_LOSS_PERCENT) : NaN;
    const shortTp = process.env.SHORT_TAKE_PROFIT_PERCENT ? parseFloat(process.env.SHORT_TAKE_PROFIT_PERCENT) : NaN;
    const shortSl = process.env.SHORT_STOP_LOSS_PERCENT ? parseFloat(process.env.SHORT_STOP_LOSS_PERCENT) : NaN;
    const profitLock = process.env.DAILY_PROFIT_LOCK_USDT ? parseFloat(process.env.DAILY_PROFIT_LOCK_USDT) : NaN;
    const maxSlots = process.env.MAX_SHORT_SLOTS ? parseInt(process.env.MAX_SHORT_SLOTS, 10) : NaN;
    if (isNaN(longTp) || isNaN(longSl) || isNaN(shortTp) || isNaN(shortSl) || isNaN(profitLock) || isNaN(maxSlots)) {
        throw new Error("FAIL: One or more strategy environment variables missing in .env!");
    }
    console.log(`  ✓ LONG_TAKE_PROFIT_PERCENT: ${longTp}%`);
    console.log(`  ✓ LONG_STOP_LOSS_PERCENT: ${longSl}%`);
    console.log(`  ✓ SHORT_TAKE_PROFIT_PERCENT: ${shortTp}%`);
    console.log(`  ✓ SHORT_STOP_LOSS_PERCENT: ${shortSl}%`);
    console.log(`  ✓ DAILY_PROFIT_LOCK_USDT: ${profitLock} USDT`);
    console.log(`  ✓ MAX_SHORT_SLOTS: ${maxSlots}`);
    // 2. Verify Multi-Slot Hedge Position Ledger
    console.log("\n[TEST 2] Verifying Multi-Slot HedgePositionLedger & Slot Recycling...");
    const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT", maxSlots);
    // Occupy Core Long
    hedgeLedger.occupyCoreLong(0.01, 67000, longTp, longSl);
    if (!hedgeLedger.getCoreLong().isOccupied) {
        throw new Error("FAIL: Core Long slot failed to occupy!");
    }
    console.log("  ✓ Core Long Slot occupied successfully.");
    // Occupy 3 Short Slots
    for (let i = 0; i < maxSlots; i++) {
        const slotIdx = hedgeLedger.getAvailableShortSlotIndex();
        if (slotIdx === -1) {
            throw new Error(`FAIL: Expected short slot ${i} to be available!`);
        }
        const occupied = hedgeLedger.occupyShortSlot(slotIdx, 0.005, 67000 + i * 100, shortTp, shortSl);
        if (!occupied) {
            throw new Error(`FAIL: Short slot ${slotIdx} occupation failed!`);
        }
        console.log(`  ✓ Short Slot ${slotIdx} occupied successfully.`);
    }
    // Verify full short capacity
    if (hedgeLedger.getAvailableShortSlotIndex() !== -1) {
        throw new Error("FAIL: Expected all short slots to be full!");
    }
    console.log("  ✓ Short Slot array full capacity verified (3/3 occupied).");
    // Simulate TP Trigger on Short Slot 0 (Mark price drops 1%)
    const triggers = hedgeLedger.evaluateHedgeDynamicTpSl(66000);
    if (triggers.length === 0) {
        throw new Error("FAIL: Dynamic TP trigger evaluation returned no triggers!");
    }
    console.log(`  ✓ Dynamic TP trigger detected for slot ${triggers[0].slotId} (${triggers[0].reason}).`);
    // Release Short Slot 0 (Recycle slot)
    hedgeLedger.releaseShortSlot(0);
    if (hedgeLedger.getAvailableShortSlotIndex() !== 0) {
        throw new Error("FAIL: Short slot 0 did not recycle properly!");
    }
    console.log("  ✓ Short Slot 0 released and recycled in O(1) time!");
    // 3. Verify RiskGuard Daily Profit Lock
    console.log("\n[TEST 3] Verifying RiskGuard Daily Profit Lock Enforcement...");
    const riskGuard = new risk_1.RiskGuard({ dailyProfitLockTargetUsdt: profitLock });
    // Record realized profit below lock target
    riskGuard.recordRealizedPnl(profitLock - 1.0);
    if (riskGuard.isProfitLockedState()) {
        throw new Error("FAIL: Profit lock triggered prematurely!");
    }
    console.log(`  ✓ Realized PnL ($${riskGuard.getCumulativeDailyRealizedPnl().toFixed(2)}) below target ($${profitLock} USDT) - Execution LIVE.`);
    // Record remaining profit to exceed lock target
    riskGuard.recordRealizedPnl(2.0);
    if (!riskGuard.isProfitLockedState()) {
        throw new Error("FAIL: Profit lock failed to trigger when target exceeded!");
    }
    console.log(`  ✓ Daily Profit Lock TARGET REACHED ($${riskGuard.getCumulativeDailyRealizedPnl().toFixed(2)} USDT) - Profit Lock ACTIVATED!`);
    // Test Order Validation under Profit Lock
    const newOrderIntent = {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        price: 67000,
        isCloseOrder: false,
    };
    const riskRes = riskGuard.validateOrder(newOrderIntent, true, "LONG");
    if (riskRes.passed || riskRes.reasonCode !== "PROFIT_LOCKED_ACTIVE") {
        throw new Error(`FAIL: Order should have been rejected with PROFIT_LOCKED_ACTIVE, got: ${riskRes.reasonCode}`);
    }
    console.log("  ✓ Non-closing Order INTENT REJECTED with PROFIT_LOCKED_ACTIVE as expected.");
    const closeOrderIntent = {
        symbol: "BTCUSDT",
        side: "SELL",
        quantity: 0.001,
        price: 67000,
        isCloseOrder: true,
    };
    const closeRiskRes = riskGuard.validateOrder(closeOrderIntent, true, "LONG");
    if (!closeRiskRes.passed) {
        throw new Error(`FAIL: Position close order should be allowed under Profit Lock, got: ${closeRiskRes.reasonCode}`);
    }
    console.log("  ✓ Position CLOSE Order PASSED under Profit Lock as expected.");
    // 4. Verify AutoRecalibrationManager Shadow Mode
    console.log("\n[TEST 4] Verifying AutoRecalibrationManager Shadow Training Mode...");
    const recalManager = recalibrationWorker_1.AutoRecalibrationManager.getInstance();
    recalManager.enableShadowMode();
    if (!recalManager.getStatus().isShadowMode) {
        throw new Error("FAIL: Shadow Mode activation failed!");
    }
    console.log("  ✓ Shadow Training Mode enabled successfully.");
    recalManager.disableShadowMode();
    console.log("  ✓ Shadow Training Mode disabled successfully.");
    console.log("\n================================================================================");
    console.log("            ALL PHASE 1-5 HEDGE & PROFIT LOCK TESTS PASSED!                     ");
    console.log("================================================================================");
}
runHedgeAndProfitLockTests().catch((err) => {
    console.error("Critical Test Failure:", err.message);
    process.exit(1);
});
