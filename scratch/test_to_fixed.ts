let sum = 0;
const n = 100000;

const t0 = process.hrtime.bigint();
for (let i = 0; i < n; i++) {
  const a = Number((0).toFixed(6));
  const b = Number((0).toFixed(6));
  const c = Number((0).toFixed(4));
  const d = Number((0).toFixed(4));
  const e = Number((0).toFixed(4));
  const f = Number((0).toFixed(4));
  const g = Number((0).toFixed(4));
  const h = Number((0).toFixed(4));
  const j = Number((0).toFixed(4));
  const k = Number((0).toFixed(4));
  const l = Number((0).toFixed(4));
  const m = Number((0).toFixed(4));
  const o = Number((0).toFixed(2));
  const p = Number((0).toFixed(2));
  sum += a + b + c + d + e + f + g + h + j + k + l + m + o + p;
}
const t1 = process.hrtime.bigint();
console.log(`With toFixed: ${(Number(t1 - t0) / n / 1000).toFixed(4)} µs per call`);

const t2 = process.hrtime.bigint();
for (let i = 0; i < n; i++) {
  const a = 0;
  const b = 0;
  const c = 0;
  const d = 0;
  const e = 0;
  const f = 0;
  const g = 0;
  const h = 0;
  const j = 0;
  const k = 0;
  const l = 0;
  const m = 0;
  const o = 0;
  const p = 0;
  sum += a + b + c + d + e + f + g + h + j + k + l + m + o + p;
}
const t3 = process.hrtime.bigint();
console.log(`Direct assignment: ${(Number(t3 - t2) / n / 1000).toFixed(4)} µs per call`);
