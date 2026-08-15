import { ClientOrderIdGenerator } from "../execution/clientOrderIdGenerator";
import { BinanceOrderParams } from "../execution/binance";
import { HedgePositionLedger } from "../strategy/positionLedger";

console.log("================================================================================");
console.log("BATBOT_V11 SOTA QA TEST SUITE: HIERARCHICAL DETERMINISTIC (HD) CLIENT_ORDER_ID");
console.log("================================================================================");

let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, testName: string) {
  if (condition) {
    console.log(`[PASS] ${testName}`);
    totalPassed++;
  } else {
    console.error(`[FAIL] ${testName}`);
    totalFailed++;
  }
}

// -----------------------------------------------------------------------------------------
// TEST 1: 36-Char Compliance & Format Verification Across All 10 Universe Assets
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 1] Testing 36-character Binance compliance across all 10 universe assets...");
const symbols = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "BNBUSDT",
  "ADAUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "DOTUSDT",
];
const slots = ["CORE_LONG", "SHORT_SLOT_0", "SHORT_SLOT_1", "SHORT_SLOT_2"];
const orderTypes = ["EN", "TP1", "TP2", "TP3", "SL", "TS", "EM"];

let allCompliant = true;
const sampleCids: string[] = [];

for (const sym of symbols) {
  for (const slot of slots) {
    for (const ot of orderTypes) {
      const cid = ClientOrderIdGenerator.generate(sym, slot, ot);
      sampleCids.push(cid);

      if (cid.length > 36 || cid.length < 15) {
        allCompliant = false;
        console.error(`Invalid length ${cid.length} for ${cid}`);
      }
      if (!/^[A-Za-z0-9_]+$/.test(cid)) {
        allCompliant = false;
        console.error(`Invalid characters in ${cid}`);
      }
      if (!cid.startsWith("BB11_")) {
        allCompliant = false;
        console.error(`Missing BB11_ prefix in ${cid}`);
      }
    }
  }
}

assert(allCompliant, `Generated ${sampleCids.length} CIDs; all strictly <= 36 characters and valid alphanumeric`);
console.log(`Sample Generated CIDs:`);
console.log(`  - BTC Long Entry:     ${ClientOrderIdGenerator.generate("BTCUSDT", "CORE_LONG", "EN")}`);
console.log(`  - XRP Long SL:        ${ClientOrderIdGenerator.generate("XRPUSDT", "CORE_LONG", "SL")}`);
console.log(`  - DOGE Short TP1:     ${ClientOrderIdGenerator.generate("DOGEUSDT", "SHORT_SLOT_0", "TP1")}`);
console.log(`  - AVAX Emergency Out: ${ClientOrderIdGenerator.generate("AVAXUSDT", "SHORT_SLOT_1", "EM")}`);

// -----------------------------------------------------------------------------------------
// TEST 2: Round-Trip O(1) Deserialization & Exact Reconstruction
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 2] Testing O(1) ClientOrderId deserialization & reconstruction...");
const testCases = [
  { sym: "XRPUSDT", slot: "CORE_LONG", type: "SL" },
  { sym: "BTCUSDT", slot: "SHORT_SLOT_2", type: "TP3" },
  { sym: "DOGEUSDT", slot: "CORE_LONG", type: "EN" },
  { sym: "ETHUSDT", slot: "SHORT_SLOT_0", type: "EM" },
];

let allParsedAccurately = true;
for (const tc of testCases) {
  const generatedCid = ClientOrderIdGenerator.generate(tc.sym, tc.slot, tc.type);
  const parsed = ClientOrderIdGenerator.parse(generatedCid);

  if (!parsed) {
    allParsedAccurately = false;
    console.error(`Failed to parse CID: ${generatedCid}`);
    continue;
  }

  if (parsed.symbol !== tc.sym || parsed.slotId !== tc.slot || parsed.orderType !== tc.type) {
    allParsedAccurately = false;
    console.error(`Mismatch in parsed CID:`, parsed, `Expected:`, tc);
  }
}

assert(allParsedAccurately, "All ClientOrderIds accurately parsed and reconstructed symbol, slotId, and orderType");

// -----------------------------------------------------------------------------------------
// TEST 3: High-Frequency Nonce Collision Resistance (4096-Burst Test)
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 3] Testing high-frequency burst collision resistance (4,096 rapid calls)...");
const seenCids = new Set<string>();
let collisions = 0;

for (let i = 0; i < 4096; i++) {
  const cid = ClientOrderIdGenerator.generate("XRPUSDT", "CORE_LONG", "TP1");
  if (seenCids.has(cid)) {
    collisions++;
  }
  seenCids.add(cid);
}

assert(collisions === 0, `Zero collisions detected across 4,096 rapid sequential generations (Unique CIDs: ${seenCids.size})`);

// -----------------------------------------------------------------------------------------
// TEST 4: Batch TP Intent Generation Attaches HD ClientOrderId
// -----------------------------------------------------------------------------------------
console.log("\n[TEST 4] Testing HedgePositionLedger.generateBatchTpOrderIntents() ClientOrderId injection...");
const ledger = new HedgePositionLedger("XRPUSDT");
const tpIntents = ledger.generateBatchTpOrderIntents("CORE_LONG", 2.50, 1000, "LONG");

assert(tpIntents.length > 0, `Generated ${tpIntents.length} TP order intents`);
let allTpCidsValid = true;
for (let i = 0; i < tpIntents.length; i++) {
  const intent = tpIntents[i];
  if (!intent.clientOrderId || !intent.clientOrderId.startsWith("BB11_XRP_L0_TP")) {
    allTpCidsValid = false;
    console.error(`Invalid TP CID: ${intent.clientOrderId}`);
  }
}
assert(allTpCidsValid, "All batch TP limit order intents have valid HD ClientOrderIds with stage identifiers");

// -----------------------------------------------------------------------------------------
// FINAL SUMMARY
// -----------------------------------------------------------------------------------------
console.log("\n================================================================================");
console.log(`TEST SUITE COMPLETE: ${totalPassed} PASSED, ${totalFailed} FAILED`);
console.log("================================================================================");

if (totalFailed > 0) {
  process.exit(1);
}
