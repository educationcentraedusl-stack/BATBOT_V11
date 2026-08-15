import * as fs from "fs";

function printUserTrades() {
  const logContent = fs.readFileSync("C:/Users/SMART PLUS/.gemini/antigravity-ide/brain/3f60ccb6-1145-44a0-a4a7-c544bfb2e603/.system_generated/tasks/task-69.log", "utf8");

  const tradeMatches = logContent.matchAll(/--- Symbol: (\w+) \(\d+ trades found\) ---\s*(\[\s*[\s\S]*?\])\s*(?=--- Symbol:|\n>>> ALL ORDERS)/g);
  const allTrades: any[] = [];
  for (const match of tradeMatches) {
    try {
      const parsed = JSON.parse(match[2]);
      allTrades.push(...parsed);
    } catch (e) {}
  }
  allTrades.sort((a, b) => a.time - b.time);

  console.log("LAST 15 TRADES:");
  for (const t of allTrades.slice(-15)) {
    console.log(JSON.stringify(t));
  }
}

printUserTrades();
