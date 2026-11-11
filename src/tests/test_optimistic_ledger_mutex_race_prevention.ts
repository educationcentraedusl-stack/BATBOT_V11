import "dotenv/config";
import { HedgePositionLedger } from "../strategy/positionLedger";
import { ClientOrderIdGenerator } from "../execution/clientOrderIdGenerator";
import { BinanceExecutionClient, BinanceOrderResponse } from "../execution/binance";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`[ASSERTION_FAILED] ${message}`);
  }
}

async function runOptimisticLedgerMutexTestSuite() {
  console.log("================================================================================");
  console.log("  BATBOT_V11 SOTA: OPTIMISTIC LEDGER MUTEX & RACE CONDITION PREVENTION");
  console.log("================================================================================\n");

  const symbol = "ETHUSDT";
  const ledger = new HedgePositionLedger(symbol, 3);
  ledger.setLeverage(20);

  // -----------------------------------------------------------------------------------------
  // TEST 1: Optimistic Mutex Reservation for CORE_LONG
  // -----------------------------------------------------------------------------------------
  console.log("[TEST 1] Testing CORE_LONG Synchronous Optimistic Reservation...");
  const cid1 = ClientOrderIdGenerator.generate(symbol, "CORE_LONG", "EN");

  // First reservation attempt: must SUCCEED
  const res1 = ledger.reserveCoreLongPending(cid1, 2600.0, 0.05);
  assert(res1, "First reservation for CORE_LONG must succeed");
  const coreLong = ledger.getCoreLong();
  assert(coreLong.lifecycleState === "PENDING_ENTRY", "CORE_LONG lifecycleState must be PENDING_ENTRY");
  assert(coreLong.pendingClientOrderId === cid1, "CORE_LONG pending CID must match");
  console.log(`  ✓ CORE_LONG successfully transitioned to PENDING_ENTRY (ClId: ${cid1})`);

  // Concurrent duplicate tick attempt during HTTP flight: must FAIL immediately
  const cid2 = ClientOrderIdGenerator.generate(symbol, "CORE_LONG", "EN");
  const res2 = ledger.reserveCoreLongPending(cid2, 2600.0, 0.05);
  assert(!res2, "Second concurrent reservation for CORE_LONG must fail");
  console.log("  ✓ Concurrent tick order dispatch correctly blocked by PENDING_ENTRY mutex barrier");

  // -----------------------------------------------------------------------------------------
  // TEST 2: Rollback Handling on Network Error / Rejection
  // -----------------------------------------------------------------------------------------
  console.log("\n[TEST 2] Testing Rollback Protocol on REST Rejection...");
  ledger.rollbackPendingSlot("CORE_LONG", "NETWORK_TIMEOUT");
  const coreLongAfterRollback = ledger.getCoreLong();
  assert(coreLongAfterRollback.lifecycleState === "FLAT", "CORE_LONG lifecycleState must rollback to FLAT");
  assert(!coreLongAfterRollback.isOccupied, "CORE_LONG must remain unoccupied");
  assert(coreLongAfterRollback.pendingClientOrderId === undefined, "CORE_LONG pending CID must be cleared");
  console.log("  ✓ CORE_LONG successfully rolled back from PENDING_ENTRY to FLAT");

  // Post-rollback re-reservation: must SUCCEED
  const cid3 = ClientOrderIdGenerator.generate(symbol, "CORE_LONG", "EN");
  const res3 = ledger.reserveCoreLongPending(cid3, 2600.5, 0.05);
  assert(res3, "Reservation after rollback must succeed");
  console.log("  ✓ Post-rollback reservation succeeded cleanly");

  // Fill confirmed: occupy slot
  ledger.occupyCoreLong(0.05, 2600.5, 2.5, 1.0);
  const coreLongOccupied = ledger.getCoreLong();
  assert(coreLongOccupied.lifecycleState === "OCCUPIED", "CORE_LONG lifecycleState must be OCCUPIED");
  assert(coreLongOccupied.isOccupied, "CORE_LONG isOccupied must be true");
  console.log("  ✓ Fill confirmation successfully transitioned CORE_LONG to OCCUPIED");

  // Attempt to reserve occupied slot: must FAIL
  const cid4 = ClientOrderIdGenerator.generate(symbol, "CORE_LONG", "EN");
  const res4 = ledger.reserveCoreLongPending(cid4, 2601.0, 0.05);
  assert(!res4, "Reservation on occupied slot must fail");
  console.log("  ✓ Reservation on OCCUPIED slot correctly blocked");

  // -----------------------------------------------------------------------------------------
  // TEST 3: SHORT_SLOTS Dispersion & PENDING_ENTRY Collision Defense
  // -----------------------------------------------------------------------------------------
  console.log("\n[TEST 3] Testing SHORT Slots Dynamic Dispersion & Mutex Reservation...");
  // Release CORE_LONG from TEST 2 first to satisfy the Unidirectional Asset Mutex before short slot entry
  ledger.releaseCoreLong(2601.0);
  const shortCid0 = ClientOrderIdGenerator.generate(symbol, "SHORT_SLOT_0", "EN");
  const shortRes0 = ledger.reserveShortSlotPending(0, shortCid0, 2600.0, 0.05);
  assert(shortRes0, "SHORT_SLOT_0 reservation must succeed");
  assert(ledger.getShortSlots()[0].lifecycleState === "PENDING_ENTRY", "SHORT_SLOT_0 must be PENDING_ENTRY");
  console.log(`  ✓ SHORT_SLOT_0 reserved in PENDING_ENTRY (ClId: ${shortCid0})`);

  // evaluateDispersedShortSlotAllocation must NOT allocate SHORT_SLOT_0 or a co-located price
  const alloc1 = ledger.evaluateDispersedShortSlotAllocation(2600.0, 0.1, 0.001, 0, 0, Date.now());
  assert(alloc1 === null, "Spatial collision at $2600.00 must be rejected against PENDING_ENTRY slot");
  console.log("  ✓ Spatial collision against PENDING_ENTRY slot correctly rejected");

  // Dispersed price allocation (e.g. $2605.00) should allocate SHORT_SLOT_1
  const alloc2 = ledger.evaluateDispersedShortSlotAllocation(2605.0, 0.1, 0.001, 0, 0, Date.now());
  assert(alloc2 !== null && alloc2.slotIndex === 1, "Dispersed price must allocate SHORT_SLOT_1");
  console.log(`  ✓ Dispersed price allocation allocated slot index ${String(alloc2?.slotIndex)}`);

  // -----------------------------------------------------------------------------------------
  // TEST 4: BinanceExecutionClient In-Flight CID Deduplication
  // -----------------------------------------------------------------------------------------
  console.log("\n[TEST 4] Testing BinanceExecutionClient In-Flight ClientOrderId Deduplication Barrier...");
  class DeferredExecutionClient extends BinanceExecutionClient {
    private releaseFirstRequest: (() => void) | null = null;

    protected override async executeHttpRequest(
      _method: "GET" | "POST" | "DELETE" | "PUT",
      endpoint: string,
      params: Record<string, string | number | boolean | undefined | null> = {}
    ): Promise<unknown> {
      if (endpoint === "/fapi/v1/order") {
        await new Promise<void>((resolve) => {
          this.releaseFirstRequest = resolve;
        });
        const orderRes: BinanceOrderResponse = {
          orderId: 900101,
          symbol: typeof params.symbol === "string" ? params.symbol : symbol,
          status: "NEW",
          clientOrderId: typeof params.newClientOrderId === "string" ? params.newClientOrderId : "",
          price: String(params.price ?? "2600.0"),
          avgPrice: "0",
          origQty: String(params.quantity ?? "0.05"),
          executedQty: "0",
          cumQuote: "0",
          timeInForce: typeof params.timeInForce === "string" ? params.timeInForce : "GTC",
          type: typeof params.type === "string" ? params.type : "LIMIT",
          reduceOnly: false,
          side: typeof params.side === "string" ? params.side : "BUY",
          positionSide: typeof params.positionSide === "string" ? params.positionSide : "LONG",
          stopPrice: "0",
          workingType: "CONTRACT_PRICE",
          updateTime: Date.now(),
        };
        return orderRes;
      }
      return {};
    }

    public releaseInFlightOrder(): void {
      if (this.releaseFirstRequest !== null) {
        this.releaseFirstRequest();
        this.releaseFirstRequest = null;
      }
    }
  }

  const client = new DeferredExecutionClient();
  const testCid = ClientOrderIdGenerator.generate(symbol, "CORE_LONG", "EN");

  const firstOrderPromise = client.placeOrder({
    symbol,
    side: "BUY",
    type: "LIMIT",
    quantity: 0.05,
    price: 2600.0,
    positionSide: "LONG",
    clientOrderId: testCid,
  });

  try {
    assert(client.hasInFlightClientOrderId(testCid), "first placeOrder call must register CID as in-flight");
    let caughtDeduplicationError = false;
    try {
      await client.placeOrder({
        symbol,
        side: "BUY",
        type: "LIMIT",
        quantity: 0.05,
        price: 2600.0,
        positionSide: "LONG",
        clientOrderId: testCid,
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("DEDUPLICATION_BARRIER")) {
        caughtDeduplicationError = true;
      }
    }
    assert(caughtDeduplicationError, "placeOrder with duplicate in-flight CID must be blocked by DEDUPLICATION_BARRIER");
    console.log("  ✓ BinanceExecutionClient correctly rejected duplicate in-flight ClientOrderId dispatch");

    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    client.releaseInFlightOrder();
    const settledOrder = await firstOrderPromise;
    assert(settledOrder.orderId === 900101, "In-flight order must resolve once HTTP dispatch finishes");
    assert(!client.hasInFlightClientOrderId(testCid), "inFlightClientOrderIds must clear CID after placeOrder completes");
  } finally {
    client.releaseInFlightOrder();
    client.destroy();
  }

  console.log("\n================================================================================");
  console.log("ALL TESTS PASSED: OPTIMISTIC MUTEX & RACE CONDITION DEFENSE VERIFIED 100%");
  console.log("================================================================================");
}

runOptimisticLedgerMutexTestSuite().catch((err: unknown) => {
  console.error("FATAL ERROR IN TEST SUITE:", err);
  process.exit(1);
});
