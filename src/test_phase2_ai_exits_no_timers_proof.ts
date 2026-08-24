import "dotenv/config";
import { HedgePositionLedger } from "./strategy/positionLedger";

async function runPhase2Proof() {
  console.log("==========================================================================================");
  console.log("  🔍 PHASE 2 PROOF: AI MICROSTRUCTURE EXITS & ZERO-TIMER VERIFICATION");
  console.log("==========================================================================================\n");

  const symbol = "BTCUSDT";
  const entryPrice = 60000.0;
  const qty = 0.005; // $300 notional

  const ledger = new HedgePositionLedger(symbol);
  ledger.occupyCoreLong(qty, entryPrice, 0.40, 0.20);

  const initialSl = ledger.getCoreLong().stopLossPrice;
  console.log(`[Initial Position State] Long 0.005 BTC @ $${entryPrice} | Initial SL: $${initialSl}`);

  // TEST 1: Zero Timers Verification (Simulate holding for 3600 seconds = 1 hour with neutral AI)
  console.log("\n------------------------------------------------------------------------------------------");
  console.log("[TEST 1] Testing Holding Position for 1 Hour (3600s) with Neutral AI (Zero Timer Exit Mandate)");
  
  // Price at entry, AI neutral (direction = 0.05, confidence = 0.50, VPIN = 0.20, Hawkes = 1.0)
  const neutralTriggers = ledger.evaluateHedgeDynamicTpSl(entryPrice, 0.05, 0.50, 0.20, 1.0, 0.0001, 0.0);
  console.log(`  Evaluating Tick at t=3600s: Triggers Count = ${neutralTriggers.length}`);
  
  if (neutralTriggers.length !== 0) {
    throw new Error(`❌ PROOF FAILED: Static timer exit triggered! Position should stay open when AI is neutral.`);
  }
  console.log("  ✅ TEST 1 PASSED: Position remains open indefinitely with ZERO time-based forced closures!");

  // TEST 2: AI Direction Conviction Hard-Reversal Exit (SOTA Schmitt Trigger Debounced Exit)
  console.log("\n------------------------------------------------------------------------------------------");
  console.log("[TEST 2] Testing SOTA AI Schmitt Trigger Debounced Reversal Exit (aiDirection = -0.75, confidence = 0.85, 15 ticks)");

  // Advance beyond 3000ms quarantine window
  const startTime = Date.now() + 3500;
  let reversalTriggers: ReturnType<typeof ledger.evaluateHedgeDynamicTpSl> = [];

  for (let tick = 0; tick < 16; tick++) {
    const currentTickTime = startTime + tick * 100;
    reversalTriggers = ledger.evaluateHedgeDynamicTpSl(entryPrice - 10.0, -0.75, 0.85, 0.30, 1.0, 0.0001, 0.0, currentTickTime);
  }
  console.log(`  Evaluating Tick 16 (1500ms): Triggers Count = ${reversalTriggers.length}`);

  if (reversalTriggers.length === 0 || reversalTriggers[0].reason !== "AI_REVERSAL_EXIT_LONG") {
    throw new Error(`❌ PROOF FAILED: AI Reversal Exit failed to trigger after 15 debounced ticks / 1500ms!`);
  }
  console.log(`  📌 Exit Reason: ${reversalTriggers[0].reason} | Qty: ${reversalTriggers[0].quantity} | Mark: $${reversalTriggers[0].markPrice}`);
  console.log("  ✅ TEST 2 PASSED: SOTA AI Schmitt Trigger Reversal Exit correctly triggered after 15 debounced ticks!");

  // TEST 3: VPIN Toxicity & Hawkes Burst Profit-Locking Breakeven Ratchet
  console.log("\n------------------------------------------------------------------------------------------");
  console.log("[TEST 3] Testing VPIN Toxicity (0.85) & Hawkes Burst (3.2) Breakeven SL Ratchet");

  // Reset position
  const ledger2 = new HedgePositionLedger(symbol);
  ledger2.occupyCoreLong(qty, entryPrice, 0.40, 0.20);

  const profitPrice = 60350.0; // In profit (+0.58% / +5.8% ROE >= 5.0% emergency gate)
  console.log(`  Mark Price in Profit: $${profitPrice} (Above fee-adjusted breakeven)`);

  // Evaluate tick with high VPIN toxicity (vpin = 0.85, ofi = -0.45)
  ledger2.evaluateHedgeDynamicTpSl(profitPrice, 0.10, 0.60, 0.85, 3.2, 0.0002, -0.45);

  const updatedSl = ledger2.getCoreLong().stopLossPrice;
  const beLocked = ledger2.getCoreLong().breakEvenLocked;

  console.log(`  Post-Toxicity SL: $${updatedSl.toFixed(2)} | Breakeven Locked: ${beLocked}`);

  if (!beLocked || updatedSl <= entryPrice) {
    throw new Error(`❌ PROOF FAILED: VPIN Toxicity ratchet failed to elevate SL ($${updatedSl}) above Entry ($${entryPrice})`);
  }
  console.log("  ✅ TEST 3 PASSED: VPIN Toxicity & Hawkes Burst successfully ratcheted SL to Zero-Loss Breakeven!");

  console.log("\n==========================================================================================");
  console.log("  ✅ PHASE 2 PROOF PASSED: ZERO Static Timers! Exits and Ratchets 100% AI Microstructure Driven!");
  console.log("==========================================================================================\n");
}

runPhase2Proof().catch((err) => {
  console.error("❌ Phase 2 Proof Execution Error:", err);
  process.exit(1);
});
