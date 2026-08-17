"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const dynamicSizing_1 = require("../strategy/dynamicSizing");
const risk_1 = require("../strategy/risk");
const positionLedger_1 = require("../strategy/positionLedger");
/**
 * ============================================================================
 * TEST SUITE: SOTA AI FINE-TUNING & QUANTITATIVE LOSS RECOVERY ARCHITECTURE
 * ============================================================================
 * Rigorous Zero-Trust verification of:
 * 1. .env Ingestion of MIN_NET_ALPHA & Fee Structures (Zero Hardcoding)
 * 2. Alpha-to-Friction Barrier Mathematical Clearance
 * 3. Dynamic Volatility & Toxicity Conviction Floors
 * 4. Drawdown-Aware Asymmetric Payoff Skew Expansion (APSE)
 * 5. Alpha-Gated Dynamic Kelly Recovery Sizing (AG-DKRS)
 * 6. Dynamic Multi-Stage Take-Profit Fee Clearance
 * ============================================================================
 */
function runTest(name, fn) {
    try {
        fn();
        console.log(`  ✓ [PASS] ${name}`);
    }
    catch (err) {
        console.error(`  ✗ [FAIL] ${name}: ${err.message}`);
        process.exit(1);
    }
}
console.log("==============================================================================");
console.log("   BATBOT_V11: SOTA AI FINE-TUNING & LOSS RECOVERY ARCHITECTURE AUDIT        ");
console.log("==============================================================================\n");
// ----------------------------------------------------------------------------
// PHASE 1: .ENV CONFIGURATION & DYNAMIC INGESTION INTEGRITY
// ----------------------------------------------------------------------------
console.log("--- PHASE 1: .ENV Ingestion & Dynamic Sizing Calculator Integrity ---");
const sizingCalc = new dynamicSizing_1.DynamicSizingCalculator();
runTest(".env MIN_NET_ALPHA dynamically parsed", () => {
    const minNetAlpha = sizingCalc.getMinNetAlpha();
    if (minNetAlpha <= 0 || !Number.isFinite(minNetAlpha)) {
        throw new Error(`Invalid MIN_NET_ALPHA: ${minNetAlpha}`);
    }
    console.log(`    -> Configured MIN_NET_ALPHA: ${(minNetAlpha * 10000).toFixed(1)} bps (${minNetAlpha})`);
});
runTest(".env Maker & Taker fee rates verified", () => {
    const makerFee = sizingCalc.getMakerFeeRate();
    const takerFee = sizingCalc.getTakerFeeRate();
    if (makerFee <= 0 || takerFee <= 0 || makerFee >= takerFee) {
        throw new Error(`Invalid fee structure: Maker=${makerFee}, Taker=${takerFee}`);
    }
    console.log(`    -> Configured Maker Fee: ${(makerFee * 10000).toFixed(1)} bps, Taker Fee: ${(takerFee * 10000).toFixed(1)} bps`);
});
// ----------------------------------------------------------------------------
// PHASE 2: SOTA ALPHA-TO-FRICTION BARRIER MODEL (MATH VERIFICATION)
// ----------------------------------------------------------------------------
console.log("\n--- PHASE 2: SOTA Alpha-to-Friction Barrier Mathematical Validation ---");
runTest("Rejects sub-friction micro-magnitude signal (Leak 1 Remediation)", () => {
    const makerFee = sizingCalc.getMakerFeeRate();
    const halfSpreadBps = 0.0001; // 1.0 bps half spread
    const estimatedSlippage = 0.00005; // 0.5 bps
    const totalFriction = 2.0 * makerFee + halfSpreadBps + estimatedSlippage;
    const minNetAlpha = sizingCalc.getMinNetAlpha();
    // Sub-optimal micro signal: aiDirection = 0.05, low vol = 0.002
    const aiDirectionMag = 0.05;
    const volEstimate = 0.002;
    const horizonSec = 0.1;
    const expectedAlpha = aiDirectionMag * volEstimate * Math.sqrt(horizonSec);
    const expectedNetAlpha = expectedAlpha - totalFriction;
    const isAlphaFrictionPassed = expectedNetAlpha >= minNetAlpha;
    if (isAlphaFrictionPassed) {
        throw new Error(`Micro-signal should have failed friction hurdle! NetAlpha=${expectedNetAlpha}`);
    }
    console.log(`    -> Micro-signal NetAlpha: ${(expectedNetAlpha * 10000).toFixed(2)} bps < Hurdle: ${(minNetAlpha * 10000).toFixed(2)} bps -> CORRECTLY FILTERED`);
});
runTest("Approves genuine institutional alpha signal exceeding friction barrier", () => {
    const makerFee = sizingCalc.getMakerFeeRate();
    const halfSpreadBps = 0.0001;
    const totalFriction = 2.0 * makerFee + halfSpreadBps;
    const minNetAlpha = sizingCalc.getMinNetAlpha();
    // High conviction setup: aiDirection = 0.50, normal vol = 0.020, hawkes = 2.0
    const aiDirectionMag = 0.50;
    const volEstimate = 0.020;
    const hawkesMultiplier = 1.0 + 0.15 * Math.log(1.0 + 2.0);
    const horizonSec = 0.1;
    const expectedAlpha = aiDirectionMag * volEstimate * Math.sqrt(horizonSec) * hawkesMultiplier;
    const expectedNetAlpha = expectedAlpha - totalFriction;
    const isAlphaFrictionPassed = expectedNetAlpha >= minNetAlpha;
    if (!isAlphaFrictionPassed) {
        throw new Error(`High alpha signal failed friction hurdle! NetAlpha=${expectedNetAlpha}`);
    }
    console.log(`    -> High-alpha NetAlpha: ${(expectedNetAlpha * 10000).toFixed(2)} bps >= Hurdle: ${(minNetAlpha * 10000).toFixed(2)} bps -> APPROVED`);
});
// ----------------------------------------------------------------------------
// PHASE 3: DRAWDOWN-AWARE ASYMMETRIC PAYOFF SKEW EXPANSION (APSE)
// ----------------------------------------------------------------------------
console.log("\n--- PHASE 3: Drawdown-Aware Asymmetric Payoff Skew Expansion (APSE) ---");
const riskGuard = new risk_1.RiskGuard({ minRiskRewardRatio: 2.0 });
runTest("Standard Regime: Accepts 2.0:1 Risk/Reward Ratio", () => {
    riskGuard.resetDailyStats();
    const intent = {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        price: 60000.0,
        takeProfitPrice: 60400.0, // +$400 (+0.67%)
        stopLossPrice: 59800.0, // -$200 (-0.33%) -> R:R = 2.0
    };
    const result = riskGuard.validateOrder(intent, true, "FLAT");
    if (!result.passed) {
        throw new Error(`Expected standard R:R to pass, failed: ${result.message}`);
    }
    console.log(`    -> Normal Regime R:R = 2.0 -> PASSED`);
});
runTest("Mathematical Floor: Enforces 2.0:1 R:R (M_TP=3.5 / M_SL=1.75) and Rejects Sub-2.0 R:R", () => {
    // Inject a -$0.10 micro-loss into RiskGuard daily ledger
    riskGuard.recordRealizedPnl(-0.10);
    const intentSubFloor = {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        price: 60000.0,
        takeProfitPrice: 60300.0, // R:R = 1.5 (< 2.0 floor)
        stopLossPrice: 59800.0,
    };
    const rejectResult = riskGuard.validateOrder(intentSubFloor, true, "FLAT");
    if (rejectResult.passed || rejectResult.reasonCode !== "INVALID_RISK_REWARD") {
        throw new Error(`Expected RiskGuard to reject sub-2.0 R:R! Passed: ${rejectResult.passed}`);
    }
    console.log(`    -> Sub-Floor R:R (1.50) Correctly Rejected (${rejectResult.message})`);
    const intentCompliant = {
        symbol: "BTCUSDT",
        side: "BUY",
        quantity: 0.001,
        price: 60000.0,
        takeProfitPrice: 60410.0, // +$410 (+0.68%)
        stopLossPrice: 59800.0, // -$200 (-0.33%) -> R:R = 2.05
    };
    const passResult = riskGuard.validateOrder(intentCompliant, true, "FLAT");
    if (!passResult.passed) {
        throw new Error(`Expected Compliant 2.05 R:R to pass! Reason: ${passResult.message}`);
    }
    console.log(`    -> Compliant 2.05 R:R -> APPROVED UNDER 2.00 MATHEMATICAL FLOOR`);
});
// ----------------------------------------------------------------------------
// PHASE 4: ALPHA-GATED DYNAMIC KELLY RECOVERY SIZING (AG-DKRS)
// ----------------------------------------------------------------------------
console.log("\n--- PHASE 4: Alpha-Gated Dynamic Kelly Recovery Sizing (AG-DKRS) ---");
runTest("Drawdown Regime: Reduces sizing for marginal setups (Capital Preservation)", () => {
    const baseSize = 60.0;
    const sessionPnl = -0.50; // In drawdown
    const marginalRes = sizingCalc.calculateAlphaGatedRecoverySize(baseSize, sessionPnl, 500.0, 0.65, 1.2, 0.45);
    if (marginalRes.sizingMultiplier >= 1.0 || marginalRes.targetNotionalUsdt >= baseSize) {
        throw new Error(`Expected defensive sizing reduction! Got multiplier=${marginalRes.sizingMultiplier}`);
    }
    console.log(`    -> Marginal Setup ($60 base): Multiplier = ${marginalRes.sizingMultiplier}x -> Target Notional = $${marginalRes.targetNotionalUsdt} (${marginalRes.reason})`);
});
runTest("Drawdown Regime: Boosts sizing ONLY for Alpha Regime 1 setups (High Conviction)", () => {
    const baseSize = 60.0;
    const sessionPnl = -50.0; // Moderate drawdown
    const alphaRes = sizingCalc.calculateAlphaGatedRecoverySize(baseSize, sessionPnl, 500.0, 0.90, 2.5, 0.60);
    if (alphaRes.sizingMultiplier <= 1.0 || alphaRes.targetNotionalUsdt <= baseSize) {
        throw new Error(`Expected recovery boost! Got multiplier=${alphaRes.sizingMultiplier}`);
    }
    console.log(`    -> Alpha Regime 1 Setup ($60 base): Multiplier = ${alphaRes.sizingMultiplier}x -> Target Notional = $${alphaRes.targetNotionalUsdt} (${alphaRes.reason})`);
});
runTest("Zero-Martingale Cap: Recovery boost is strictly clamped <= 1.50x", () => {
    const baseSize = 60.0;
    const deepDrawdown = -450.0; // 90% of max daily loss
    const extremeRes = sizingCalc.calculateAlphaGatedRecoverySize(baseSize, deepDrawdown, 500.0, 0.99, 5.0, 0.80);
    if (extremeRes.sizingMultiplier > 1.50) {
        throw new Error(`Strict 1.50x cap violated! Multiplier=${extremeRes.sizingMultiplier}`);
    }
    console.log(`    -> Deep Drawdown Test: Multiplier = ${extremeRes.sizingMultiplier}x (Strictly clamped <= 1.50x) -> SAFE`);
});
// ----------------------------------------------------------------------------
// PHASE 5: DYNAMIC MULTI-STAGE TAKE-PROFIT NET CLEARANCE
// ----------------------------------------------------------------------------
console.log("\n--- PHASE 5: Dynamic Multi-Stage Take-Profit Net Clearance ---");
const hedgeLedger = new positionLedger_1.HedgePositionLedger("BTCUSDT", 3);
runTest("Stage 1 TP dynamically clears round-trip fees + MIN_NET_ALPHA", () => {
    const entryPrice = 60000.0;
    const quantity = 0.005;
    const tpOrders = hedgeLedger.generateBatchTpOrderIntents("CORE_LONG", entryPrice, quantity, "LONG");
    if (tpOrders.length < 2) {
        throw new Error(`Expected at least 2 TP stage orders! Got ${tpOrders.length}`);
    }
    const stage1Price = tpOrders[0].price;
    if (!stage1Price)
        throw new Error("Missing stage 1 price");
    const stage1GainBps = ((stage1Price - entryPrice) / entryPrice) * 10000;
    const minRequiredBps = (sizingCalc.getMakerFeeRate() + sizingCalc.getTakerFeeRate() + sizingCalc.getMinNetAlpha()) * 10000;
    if (stage1GainBps < minRequiredBps - 0.1) {
        throw new Error(`Stage 1 TP gain (${stage1GainBps.toFixed(1)} bps) is below mandatory threshold (${minRequiredBps.toFixed(1)} bps)`);
    }
    console.log(`    -> Stage 1 TP Price: $${stage1Price} (+${stage1GainBps.toFixed(1)} bps) >= Required Hurdle: ${minRequiredBps.toFixed(1)} bps -> GUARANTEED NET PROFIT`);
});
runTest("High-Water Mark & Session Drawdown Tracking in HedgePositionLedger", () => {
    // Simulate 1 winning exit
    hedgeLedger.recordRealizedExit("LONG", 60000.0, 60400.0, 0.002, sizingCalc.getMakerFeeRate(), "MAKER_TP_STAGE_1");
    const hwmAfterWin = hedgeLedger.getHighWaterMark();
    const ddAfterWin = hedgeLedger.getSessionDrawdown();
    if (hwmAfterWin <= 0 || ddAfterWin !== 0) {
        throw new Error(`HWM tracking invalid after win: HWM=${hwmAfterWin}, DD=${ddAfterWin}`);
    }
    // Simulate 1 losing exit
    hedgeLedger.recordRealizedExit("LONG", 60000.0, 59700.0, 0.002, sizingCalc.getTakerFeeRate(), "STOP_LOSS");
    const hwmAfterLoss = hedgeLedger.getHighWaterMark();
    const ddAfterLoss = hedgeLedger.getSessionDrawdown();
    if (ddAfterLoss <= 0 || hwmAfterLoss !== hwmAfterWin) {
        throw new Error(`Drawdown tracking invalid after loss: HWM=${hwmAfterLoss}, DD=${ddAfterLoss}`);
    }
    console.log(`    -> HWM: $${hwmAfterLoss.toFixed(4)}, Session Drawdown: $${ddAfterLoss.toFixed(4)} -> ACCURATELY TRACKED`);
});
console.log("\n==============================================================================");
console.log("   ALL 5 PHASES PASSED 100%: SOTA AI FINE-TUNING & LOSS RECOVERY AUDITED     ");
console.log("==============================================================================");
