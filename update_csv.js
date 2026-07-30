const fs = require("fs");
const path = require("path");

const csvPath = path.resolve(__dirname, "data/trade_history.csv");

if (!fs.existsSync(csvPath)) {
  console.log(`[Backfill] File not found at ${csvPath}`);
  process.exit(1);
}

const content = fs.readFileSync(csvPath, "utf8");
const lines = content.trim().split("\n");

if (lines.length === 0 || !lines[0].trim()) {
  console.log("[Backfill] CSV file is empty.");
  process.exit(0);
}

const header = lines[0].trim();
let newHeader = header;
if (!header.endsWith(",Win/Loss")) {
  newHeader = header + ",Win/Loss";
}

let winCount = 0;
let lossCount = 0;

const updatedLines = [newHeader];

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const cols = line.split(",");
  if (cols.length === 10) {
    const pnlUsdt = parseFloat(cols[9]);
    const winLoss = (!isNaN(pnlUsdt) && pnlUsdt > 0) ? "Win" : "Loss";
    if (winLoss === "Win") winCount++;
    else lossCount++;
    updatedLines.push(`${line},${winLoss}`);
  } else if (cols.length === 11) {
    if (cols[10] === "Win") winCount++;
    else if (cols[10] === "Loss") lossCount++;
    updatedLines.push(line);
  } else {
    updatedLines.push(line);
  }
}

const outputContent = updatedLines.join("\n") + "\n";
fs.writeFileSync(csvPath, outputContent, "utf8");

console.log(`[Backfill Success] Updated ${csvPath} cleanly.`);
console.log(`  Header: ${newHeader}`);
console.log(`  Total Rows Processed: ${updatedLines.length - 1}`);
console.log(`  Wins: ${winCount}, Losses: ${lossCount}`);
