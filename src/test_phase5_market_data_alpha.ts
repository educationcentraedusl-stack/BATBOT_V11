import {
  initCore,
  createMultiAssetLobManagerNapi,
  startPhase5OrchestratorNapi,
  stopPhase5OrchestratorNapi,
  getPhase5OrchestratorMetricsNapi,
  startMultiAssetOmsNapi,
} from '../index';

async function runPhase5IntegrationTest() {
  console.log('================================================================');
  console.log('⚡ BATBOT_V11: PHASE 5 MARKET DATA & ALPHA ENGINE INTEGRATION TEST');
  console.log('================================================================');

  // 1. Core Engine Initialization
  const coreStatus = initCore();
  console.log(`[Phase 5 QA] Core Engine Status: ${coreStatus}`);
  if (coreStatus !== 'BATBOT_V11_CORE_INITIALIZED') {
    throw new Error('Core engine failed to initialize!');
  }

  // 2. Initialize Multi-Asset L2 LOB Manager
  const lobCreated = createMultiAssetLobManagerNapi();
  console.log(`[Phase 5 QA] Multi-Asset L2 LOB Manager initialized: ${lobCreated}`);
  if (!lobCreated) {
    throw new Error('Failed to initialize Multi-Asset LOB Manager!');
  }

  // 3. Initialize Multi-Asset OMS Engine
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'];
  const omsStarted = startMultiAssetOmsNapi(100000.0, JSON.stringify(symbols));
  console.log(`[Phase 5 QA] Multi-Asset OMS Engine initialized: ${omsStarted}`);
  if (!omsStarted) {
    throw new Error('Failed to initialize Multi-Asset OMS Engine!');
  }

  // 4. Start Strategy Orchestrator & Ingestion Stream Pipeline
  console.log('[Phase 5 QA] Launching Strategy Orchestrator & Multi-Stream Manager...');
  const orchStarted = startPhase5OrchestratorNapi(symbols);
  console.log(`[Phase 5 QA] Strategy Orchestrator Status: ${orchStarted}`);
  if (!orchStarted) {
    throw new Error('Failed to start Strategy Orchestrator!');
  }

  // 5. Monitor Orchestrator Metrics over 3 seconds
  console.log('[Phase 5 QA] Monitoring synchronous orchestrator execution...');
  for (let i = 1; i <= 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const metricsJson = getPhase5OrchestratorMetricsNapi();
    console.log(`[Phase 5 QA] Second ${i} Metrics: ${metricsJson}`);
    const metrics = JSON.parse(metricsJson);
    if (metrics.status !== 'ACTIVE') {
      throw new Error('Orchestrator metrics status is not ACTIVE!');
    }
  }

  // 6. Clean Stop
  console.log('[Phase 5 QA] Stopping Strategy Orchestrator...');
  const stopped = stopPhase5OrchestratorNapi();
  console.log(`[Phase 5 QA] Strategy Orchestrator stopped cleanly: ${stopped}`);

  console.log('================================================================');
  console.log('✅ PHASE 5 MARKET DATA INGESTION & ALPHA ENGINE QA VERIFIED SUCCESS');
  console.log('================================================================');
}

runPhase5IntegrationTest().catch((err) => {
  console.error('❌ Phase 5 Integration Test Failed:', err);
  process.exit(1);
});
