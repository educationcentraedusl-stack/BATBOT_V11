"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * SOTA VERIFICATION TEST: Stoikov-Lehalle Multi-Scale Breathing Boundary & Two-Tier Exit Routing
 * Validates that normal sub-second 10-15 bps noise cannot trigger false HJB panic liquidations.
 */
const hjbReservationEngine_1 = require("../strategy/hjbReservationEngine");
function runHjbBreathingTest() {
    console.log("=== SOTA TEST 1: HJB Multi-Scale Breathing Boundary & Noise Immunity ===");
    const hjbEngine = new hjbReservationEngine_1.HJBReservationEngine("BTCUSDT", 0.10, 60.0, 1.5);
    const entryPrice = 77000.0;
    const normalNoisePrice = 76923.0; // -10 bps dip (0.10% drop)
    const safeVol = 0.0020; // 20 bps standard volatility
    // Test at 500ms duration (sub-second tick noise)
    const evalImmediate = hjbEngine.getOptimalExitBoundary("LONG", entryPrice, normalNoisePrice, 0.001, 500, // 500ms
    safeVol);
    console.log(`[TEST_1] Entry: $${entryPrice}, Current (10 bps dip): $${normalNoisePrice}`);
    console.log(`[TEST_1] Reservation Price: $${evalImmediate.reservationPrice.toFixed(2)}`);
    console.log(`[TEST_1] Liquidation Boundary: $${evalImmediate.liquidationBoundary.toFixed(2)}`);
    console.log(`[TEST_1] Is Liquidation Triggered: ${evalImmediate.isLiquidationTriggered}`);
    if (evalImmediate.isLiquidationTriggered) {
        throw new Error("FAIL: 10 bps micro-dip triggered false HJB liquidation!");
    }
    // Verify boundary distance is >= 50 bps (0.50% = $385 on $77,000)
    const breathingDistance = entryPrice - evalImmediate.liquidationBoundary;
    const breathingBps = (breathingDistance / entryPrice) * 10000;
    console.log(`[TEST_1] Active Breathing Margin: ${breathingBps.toFixed(1)} bps (Required: >= 50.0 bps)`);
    if (breathingBps < 50.0) {
        throw new Error(`FAIL: Breathing margin ${breathingBps} bps is less than 50 bps floor!`);
    }
    // Test true catastrophic drop (-100 bps)
    const catastrophicPrice = 76230.0; // -1.0% drop
    const evalCatastrophic = hjbEngine.getOptimalExitBoundary("LONG", entryPrice, catastrophicPrice, 0.001, 5000, safeVol);
    console.log(`[TEST_1] Catastrophic Drop Price ($${catastrophicPrice}): Triggered = ${evalCatastrophic.isLiquidationTriggered}`);
    if (!evalCatastrophic.isLiquidationTriggered) {
        throw new Error("FAIL: Catastrophic drop failed to trigger liquidation boundary!");
    }
    console.log("✅ TEST 1 PASSED: HJB Multi-Scale Breathing Boundary provides robust noise immunity without sacrificing downside protection.\n");
}
runHjbBreathingTest();
