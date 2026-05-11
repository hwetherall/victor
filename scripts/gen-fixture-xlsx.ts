// One-shot fixture generator for STORY-024 dev/testing. Produces a 4-tab
// xlsx that mimics what the bottoms-up-financial-model skill should output,
// so ArtifactViewer can be developed against real-shaped data without
// burning Anthropic budget.
//
// Run: npx tsx scripts/gen-fixture-xlsx.ts
// Output: public/fixtures/sample-financial-model.xlsx

import * as XLSX from "xlsx";
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = path.resolve("public/fixtures/sample-financial-model.xlsx");

// ─── Sheet 1: Inputs ─────────────────────────────────────────────────────────
const inputs: (string | number)[][] = [
  ["Input", "Value", "Unit", "Source", "Confidence"],
  ["horizon_years", 5, "years", "case scope", "high"],
  ["capex_year0_millions", 30, "M USD", "ABB pitch deck slide 7", "medium"],
  ["gross_margin_pct", 0.35, "fraction", "ABB 10-K segment data, p.42", "medium"],
  ["sga_pct_revenue", 0.10, "fraction", "industry avg (Vertiv, Schneider)", "low"],
  ["tax_rate", 0.21, "fraction", "US federal", "high"],
  ["wacc", 0.09, "fraction", "ABB IR deck slide 7", "high"],
  ["irr_hurdle", 0.15, "fraction", "case threshold", "high"],
  ["terminal_growth", 0.02, "fraction", "long-run GDP", "medium"],
  [],
  ["Revenue ramp"],
  ["Year", "Revenue (USD M)"],
  [1, 5],
  [2, 25],
  [3, 75],
  [4, 120],
  [5, 160],
];

// ─── Sheet 2: Scenarios ──────────────────────────────────────────────────────
const scenarios: (string | number)[][] = [
  ["Year", "Bear (60% of base)", "Base", "Bull (130% of base)"],
  [1, 3.0, 5, 6.5],
  [2, 15.0, 25, 32.5],
  [3, 45.0, 75, 97.5],
  [4, 72.0, 120, 156.0],
  [5, 96.0, 160, 208.0],
  [],
  ["Note: scenarios scale revenue ramp only. For capex / margin / WACC stress, use sensitivity-analysis."],
];

// ─── Sheet 3: NPV bridge ─────────────────────────────────────────────────────
// Fully expanded numbers (no formulas) so the viewer can read clean values.
const wacc = 0.09;
const margin = 0.35;
const sga = 0.10;
const tax = 0.21;
const tg = 0.02;
const ramp = [5, 25, 75, 120, 160];
const capex = [30, 0, 0, 0, 0];

function df(year: number) {
  return 1 / Math.pow(1 + wacc, year);
}

const bridge: (string | number)[][] = [
  ["Line item", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"],
];
const lineNames = [
  "Revenue", "COGS", "Gross profit", "SG&A", "EBIT", "Tax", "NOPAT",
  "Capex", "Free cash flow", "Discount factor", "Discounted FCF",
];
const lines: number[][] = lineNames.map(() => []);
for (let y = 1; y <= 5; y++) {
  const rev = ramp[y - 1];
  const cogs = -rev * (1 - margin);
  const gp = rev + cogs;
  const sgaCost = -rev * sga;
  const ebit = gp + sgaCost;
  const taxAmt = -Math.max(0, ebit) * tax;
  const nopat = ebit + taxAmt;
  const cap = -capex[y - 1];
  const fcf = nopat + cap;
  const dfac = df(y);
  const discFcf = fcf * dfac;
  lines[0].push(rev);
  lines[1].push(cogs);
  lines[2].push(gp);
  lines[3].push(sgaCost);
  lines[4].push(ebit);
  lines[5].push(taxAmt);
  lines[6].push(nopat);
  lines[7].push(cap);
  lines[8].push(fcf);
  lines[9].push(dfac);
  lines[10].push(discFcf);
}
for (let i = 0; i < lineNames.length; i++) {
  bridge.push([lineNames[i], ...lines[i].map((n) => Math.round(n * 100) / 100)]);
}
// Terminal value
const fcf5 = lines[8][4];
const tv = (fcf5 * (1 + tg)) / (wacc - tg);
const tvPv = tv * df(5);
bridge.push([], ["Terminal value (PV)", "", "", "", "", Math.round(tvPv * 100) / 100]);

const npv = lines[10].reduce((a, b) => a + b, 0) + tvPv;
const irr = computeIRR(lines[8]);
bridge.push([], ["NPV @ WACC", Math.round(npv * 100) / 100]);
bridge.push(["IRR (undiscounted FCF)", irr === null ? "n/a" : `${(irr * 100).toFixed(2)}%`]);

function computeIRR(flows: number[], guess = 0.1): number | null {
  // Newton-Raphson against NPV(r) = 0
  let r = guess;
  for (let i = 0; i < 60; i++) {
    let npv = 0;
    let dnpv = 0;
    for (let t = 0; t < flows.length; t++) {
      const denom = Math.pow(1 + r, t + 1);
      npv += flows[t] / denom;
      dnpv += (-(t + 1) * flows[t]) / Math.pow(1 + r, t + 2);
    }
    if (Math.abs(dnpv) < 1e-12) return null;
    const next = r - npv / dnpv;
    if (Math.abs(next - r) < 1e-7) return next;
    r = next;
  }
  return null;
}

// ─── Sheet 4: Conclusion ─────────────────────────────────────────────────────
const verdict =
  irr !== null && irr >= 0.15
    ? `PASS: IRR ${(irr * 100).toFixed(1)}% clears hurdle of 15%`
    : `FAIL: IRR ${irr === null ? "n/a" : (irr * 100).toFixed(1) + "%"} below hurdle of 15%`;

const conclusion: (string | number)[][] = [
  ["Investment vs ramp — base case"],
  [],
  ["Verdict (IRR vs hurdle)", verdict],
  ["NPV @ WACC", Math.round(npv * 100) / 100],
  ["IRR", irr === null ? "n/a" : `${(irr * 100).toFixed(2)}%`],
  [],
  [
    "Dominant assumption",
    "Year-3 revenue ramp ($75M) and gross margin (35%). If either is off by >25%, verdict flips. Apply sensitivity-analysis to confirm.",
  ],
  [
    "Confidence cap",
    "0.6 — single-point estimate without sensitivity. To raise above 0.6 run sensitivity-analysis on the dominant assumption.",
  ],
];

// ─── Compose workbook ────────────────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(inputs), "Inputs");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(scenarios), "Scenarios");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(bridge), "NPV bridge");
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(conclusion), "Conclusion");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
XLSX.writeFile(wb, OUT);
const stat = fs.statSync(OUT);
console.log(`✓ Wrote ${OUT} (${stat.size} bytes)`);
console.log(`  4 tabs: Inputs / Scenarios / NPV bridge / Conclusion`);
console.log(`  NPV: ${Math.round(npv * 100) / 100}M, IRR: ${irr === null ? "n/a" : (irr * 100).toFixed(2) + "%"}`);
