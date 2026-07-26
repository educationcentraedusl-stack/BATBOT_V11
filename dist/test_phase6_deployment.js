"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const binance_1 = require("./execution/binance");
async function httpGet(urlStr) {
    const res = await fetch(urlStr, {
        headers: {
            "User-Agent": "BATBOT_V11-HFT-Engine/1.0",
        },
    });
    const body = await res.text();
    return { status: res.status, body };
}
async function runPhase6DeploymentTests() {
    console.log("=================================================");
    console.log("  BATBOT_V11 PHASE 6 DEPLOYMENT & TESTNET AUDIT  ");
    console.log("=================================================\n");
    let passedTests = 0;
    let totalTests = 0;
    // TEST 1: Default Testnet Environment Resolution
    totalTests++;
    process.env.USE_TESTNET = "true";
    const testnetClient = new binance_1.BinanceExecutionClient();
    console.log("[TEST 1] Testing BinanceExecutionClient under USE_TESTNET=true...");
    console.log(`  - isTestnet(): ${testnetClient.isTestnet()}`);
    console.log(`  - getBaseUrl(): ${testnetClient.getBaseUrl()}`);
    console.log(`  - getWsUrl(): ${testnetClient.getWsUrl()}`);
    if (testnetClient.isTestnet() === true &&
        testnetClient.getBaseUrl() === "https://testnet.binancefuture.com" &&
        testnetClient.getWsUrl() === "wss://stream.binancefuture.com") {
        console.log("  ✅ TEST 1 PASSED: Testnet URL routing is accurate.\n");
        passedTests++;
    }
    else {
        console.error("  ❌ TEST 1 FAILED: Invalid Testnet URL resolution.\n");
    }
    // TEST 2: Production Live Environment Resolution
    totalTests++;
    const liveClient = new binance_1.BinanceExecutionClient({ useTestnet: false });
    console.log("[TEST 2] Testing BinanceExecutionClient under useTestnet=false...");
    console.log(`  - isTestnet(): ${liveClient.isTestnet()}`);
    console.log(`  - getBaseUrl(): ${liveClient.getBaseUrl()}`);
    console.log(`  - getWsUrl(): ${liveClient.getWsUrl()}`);
    if (liveClient.isTestnet() === false &&
        liveClient.getBaseUrl() === "https://fapi.binance.com" &&
        liveClient.getWsUrl() === "wss://fstream.binance.com") {
        console.log("  ✅ TEST 2 PASSED: Production Live URL routing is accurate.\n");
        passedTests++;
    }
    else {
        console.error("  ❌ TEST 2 FAILED: Invalid Live URL resolution.\n");
    }
    // TEST 3: Binance Futures Testnet Connectivity Ping
    totalTests++;
    console.log("[TEST 3] Pinging Binance Futures Testnet Endpoint (https://testnet.binancefuture.com/fapi/v1/ping)...");
    try {
        const res = await httpGet("https://testnet.binancefuture.com/fapi/v1/ping");
        console.log(`  - HTTP Status: ${res.status}`);
        if (res.status === 200) {
            console.log("  ✅ TEST 3 PASSED: Binance Futures Testnet endpoint is online and reachable.\n");
            passedTests++;
        }
        else {
            console.error(`  ❌ TEST 3 FAILED: Non-200 status from Testnet (${res.status}).\n`);
        }
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ TEST 3 FAILED: Network error reaching Binance Testnet: ${errorMsg}\n`);
    }
    // TEST 4: Binance Production Endpoint Ping
    totalTests++;
    console.log("[TEST 4] Pinging Binance Futures Production Endpoint (https://fapi.binance.com/fapi/v1/ping)...");
    try {
        const res = await httpGet("https://fapi.binance.com/fapi/v1/ping");
        console.log(`  - HTTP Status: ${res.status}`);
        if (res.status === 200) {
            console.log("  ✅ TEST 4 PASSED: Binance Futures Production endpoint is online and reachable.\n");
            passedTests++;
        }
        else {
            console.error(`  ❌ TEST 4 FAILED: Non-200 status from Production (${res.status}).\n`);
        }
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(`  ❌ TEST 4 FAILED: Network error reaching Binance Production: ${errorMsg}\n`);
    }
    console.log("=================================================");
    console.log(`SUMMARY: ${passedTests} / ${totalTests} Deployment Verification Tests Passed`);
    console.log("=================================================");
    if (passedTests === totalTests) {
        console.log("\n🚀 PHASE 6 PRODUCTION & TESTNET SETUP VERIFIED SUCCESSFULLY!");
        process.exit(0);
    }
    else {
        console.error("\n💥 DEPLOYMENT AUDIT FAILED! Review test logs above.");
        process.exit(1);
    }
}
runPhase6DeploymentTests();
