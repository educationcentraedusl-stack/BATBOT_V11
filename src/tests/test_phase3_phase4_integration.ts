import "dotenv/config";
import { MarketDataClient } from "../marketDataClient";
import { RiskGuard } from "../strategy/risk";
import { BinanceExecutionClient } from "../execution/binance";
import { StrategyEngine } from "../strategy/engine";
import { HedgePositionLedger } from "../strategy/positionLedger";

async function runPhase3Phase4IntegrationTest() {
  console.log(`=======================================================`);
  console.log(`[TEST] BATBOT_V11 Phase 3 & Phase 4 Integration Test Suite`);
  console.log(`=======================================================\n`);

  // 1. Initialize HedgePositionLedger and test POST_ONLY TP intent generation
  console.log(`[TEST 1] Testing HedgePositionLedger.generateBatchTpOrderIntents()...`);
  const ledger = new HedgePositionLedger("BTCUSDT", 3);

  // Occupy Core Long position: 0.005 BTC @ $60,000 ($300 USDT Notional -> 3-stage ladder)
  ledger.occupyCoreLong(0.005, 60000, 2.5, 1.2);
  const coreLongSlot = ledger.getCoreLong();

  console.log(`- Core Long Occupied: Qty = ${coreLongSlot.quantity}, Entry = $${coreLongSlot.entryPrice}`);

  const tpIntents = ledger.generateBatchTpOrderIntents("CORE_LONG", 60000, 0.005, "LONG");
  console.log(`- Generated ${tpIntents.length} POST_ONLY TP limit order intents:`);
  tpIntents.forEach((intent, idx) => {
    console.log(`  Stage ${idx + 1}: ${intent.side} ${intent.quantity} ${intent.symbol} @ $${intent.price} [${intent.timeInForce}]`);
  });

  if (tpIntents.length !== 3) {
    throw new Error(`TEST FAILED: Large position ($300 Notional) should generate 3 POST_ONLY TP order intents.`);
  }

  // Verify timeInForce is strictly "GTX" (POST_ONLY)
  for (const intent of tpIntents) {
    if (intent.timeInForce !== "GTX" || intent.type !== "LIMIT") {
      throw new Error(`TEST FAILED: Take Profit order must be LIMIT with timeInForce = GTX (POST_ONLY).`);
    }
  }
  console.log(`- POST_ONLY GTX order intent format verified.\n`);

  // 2. Register Mock Active Order IDs and simulate WebSocket limit TP fill
  console.log(`[TEST 2] Simulating WebSocket Limit TP Fill & Trailing SL Advance...`);
  const mockOrderIds = [100001, 100002, 100003];
  ledger.registerActiveTpOrderIds("CORE_LONG", mockOrderIds);

  console.log(`- Registered Active Order IDs:`, ledger.getCoreLong().activeTpOrderIds);

  // Fill Stage 1 Limit TP Order (#100001) for 0.002 BTC @ $60,150
  const fill1Res = ledger.processTpLimitFill("CORE_LONG", 100001, 0.002, 60150, true);
  console.log(`- Stage 1 Limit TP Filled as MAKER:`);
  console.log(`  Closed: ${fill1Res.isPositionClosed}`);
  console.log(`  Remaining Qty: ${fill1Res.remainingQuantity}`);
  console.log(`  New Stop Loss Price (Locked Break-Even): $${fill1Res.newStopLossPrice.toFixed(2)}`);

  if (!ledger.getCoreLong().breakEvenLocked || fill1Res.newStopLossPrice <= 60000) {
    throw new Error(`TEST FAILED: Stage 1 fill must lock Break-Even Stop Loss above entry price ($60,000).`);
  }
  console.log(`- Stage 1 fill Break-Even SL lock verified.\n`);

  // 3. Simulate Stop-Loss Breach Trigger & Order Cancellation
  console.log(`[TEST 3] Evaluating Stop-Loss Breach & Batch Cancellation Trigger...`);
  // Mark price drops to $59,500 (below Break-Even SL of ~$60,037)
  const triggers = ledger.evaluateHedgeDynamicTpSl(59500);

  if (triggers.length === 0) {
    throw new Error(`TEST FAILED: Mark price ($59,500) below SL should emit an emergency Stop-Loss trigger.`);
  }

  const slTrigger = triggers[0];
  console.log(`- Emergency SL Triggered: Reason = ${slTrigger.reason}, Slot = ${slTrigger.slotId}`);
  console.log(`- Open Limit TP Order IDs to Cancel:`, slTrigger.cancelOrderIds);

  if (!slTrigger.cancelOrderIds || slTrigger.cancelOrderIds.length !== 2) {
    throw new Error(`TEST FAILED: Emergency SL trigger must attach remaining active order IDs to cancel.`);
  }
  console.log(`- Emergency batch order cancellation IDs verified.\n`);

  console.log(`=======================================================`);
  console.log(`✅ ALL PHASE 3 & PHASE 4 INTEGRATION TESTS PASSED!`);
  console.log(`=======================================================\n`);
}

runPhase3Phase4IntegrationTest().catch((err) => {
  console.error(`❌ INTEGRATION TEST ERROR: ${err.message}`);
  process.exit(1);
});
