// Mock financial model data for the IRR & Payback drill-down panel.
// Numbers are hand-tuned per mode so FCF arithmetic ties out row-by-row and
// the result tiles land at plausible IRR/NPV/Payback values. Hurdle is
// duplicated here as a constant rather than read from cases/abb-rack-pdu.yaml
// at runtime — single-case demo, not worth the plumbing.

export type FinancialMode = "build" | "buy" | "partner";

export type RowKey =
  | "Revenue"
  | "COGS"
  | "Gross Profit"
  | "S&M"
  | "R&D"
  | "EBITDA"
  | "D&A"
  | "EBIT"
  | "Tax"
  | "NOPAT"
  | "Capex"
  | "Delta Working Capital"
  | "Unlevered FCF";

export const ROW_ORDER: readonly RowKey[] = [
  "Revenue",
  "COGS",
  "Gross Profit",
  "S&M",
  "R&D",
  "EBITDA",
  "D&A",
  "EBIT",
  "Tax",
  "NOPAT",
  "Capex",
  "Delta Working Capital",
  "Unlevered FCF",
];

// Subtotal rows get a top border and brighter text — matches how investment
// memos visually separate calculation blocks.
export const SUBTOTAL_ROWS: ReadonlySet<RowKey> = new Set([
  "Gross Profit",
  "EBITDA",
  "NOPAT",
  "Unlevered FCF",
]);

export const YEAR_LABELS = ["Year 0", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"] as const;

export const IRR_HURDLE = 0.15;
export const WACC = 0.12;

export interface FinancialResults {
  /** NPV at 12% WACC, in $M. */
  npv: number;
  /** IRR as a decimal (0.187 = 18.7%). */
  irr: number;
  /** Payback period in years, fractional. */
  payback: number;
}

export interface FinancialModel {
  rows: Record<RowKey, number[]>;
  results: FinancialResults;
  /** Static for now; structured as a string prop so a future LLM-generated
   *  narration can slot in without a component rewrite. */
  narration: string;
}

export const MODE_LABELS: Record<FinancialMode, string> = {
  build: "Build",
  buy: "Buy",
  partner: "Partner",
};

export const MODE_DESCRIPTIONS: Record<FinancialMode, string> = {
  build: "Internal build: tooling + R&D capex, multi-year ramp",
  buy: "Acquisition: $180M upfront for inherited revenue and channel",
  partner: "Revenue-share partnership (Vertiv-style): low capex, capped upside",
};

// ─── Build mode ──────────────────────────────────────────────────────────────
// Heavy upfront R&D + tooling, slow revenue ramp. NPV at 12% ≈ -$0.6M, IRR ≈ 11.9%.
// Fails the 15% hurdle by ~310bps and payback exceeds the 3-year horizon.

const BUILD: FinancialModel = {
  rows: {
    Revenue:                 [  0,  40, 120, 250, 340, 460],
    COGS:                    [  0,  28,  75, 145, 188, 246],
    "Gross Profit":          [  0,  12,  45, 105, 152, 214],
    "S&M":                   [  5,  12,  20,  30,  36,  42],
    "R&D":                   [ 40,  20,  18,  20,  20,  22],
    EBITDA:                  [-45, -20,   7,  55,  96, 150],
    "D&A":                   [  5,   5,   7,   8,   9,  10],
    EBIT:                    [-50, -25,   0,  47,  87, 140],
    Tax:                     [  0,   0,   0,  12,  22,  35],
    NOPAT:                   [-50, -25,   0,  35,  65, 105],
    Capex:                   [ 40,   6,   4,   5,   7,   8],
    "Delta Working Capital": [  5,   4,   3,   8,   7,   7],
    "Unlevered FCF":         [-90, -30,   0,  30,  60, 100],
  },
  results: { npv: -0.6, irr: 0.119, payback: 4.3 },
  narration:
    "IRR of 11.9% misses ABB's 15% hurdle by 310bps. Payback of 4.3 years also exceeds the 3-year horizon — capital efficiency requirement not met under the build path.",
};

// ─── Buy mode ────────────────────────────────────────────────────────────────
// $180M acquisition Y0, then operates inherited revenue base. NPV at 12% ≈
// $37.6M, IRR ≈ 18.7%, payback ≈ 3.4y. Passes hurdle with strongest absolute
// return.

const BUY: FinancialModel = {
  rows: {
    Revenue:                 [  0, 175, 245, 300, 360, 420],
    COGS:                    [  0, 104, 137, 165, 195, 224],
    "Gross Profit":          [  0,  71, 108, 135, 165, 196],
    "S&M":                   [  0,  19,  24,  28,  32,  35],
    "R&D":                   [  0,   8,  10,  12,  12,  14],
    EBITDA:                  [  0,  44,  74,  95, 121, 147],
    "D&A":                   [  0,  12,  12,  12,  12,  12],
    EBIT:                    [  0,  32,  62,  83, 109, 135],
    Tax:                     [  0,   8,  16,  21,  27,  34],
    NOPAT:                   [  0,  24,  46,  62,  82, 101],
    Capex:                   [180,   3,   4,   5,   5,   6],
    "Delta Working Capital": [  0,   3,   4,   4,   9,  12],
    "Unlevered FCF":         [-180, 30,  50,  65,  80,  95],
  },
  results: { npv: 37.6, irr: 0.187, payback: 3.4 },
  narration:
    "IRR of 18.7% clears ABB's 15% hurdle by 370bps. NPV of $37.6M at 12% WACC supports the acquisition multiple — capital efficiency requirement met.",
};

// ─── Partner mode ────────────────────────────────────────────────────────────
// Revenue-share: low capex, lower revenue (ABB's share of partner-fronted
// volume), thinner absolute return but high capital efficiency. IRR ≈ 22.2%,
// NPV at 12% ≈ $14.7M (less than half of Buy), payback ≈ 3.3y.

const PARTNER: FinancialModel = {
  rows: {
    Revenue:                 [  0,  35,  65,  85, 105, 125],
    COGS:                    [  0,  21,  38,  49,  60,  71],
    "Gross Profit":          [  0,  14,  27,  36,  45,  54],
    "S&M":                   [  5,   5,   7,   8,   9,  10],
    "R&D":                   [  4,   2,   2,   2,   3,   3],
    EBITDA:                  [ -9,   7,  18,  26,  33,  41],
    "D&A":                   [  1,   2,   2,   2,   2,   2],
    EBIT:                    [-10,   5,  16,  24,  31,  39],
    Tax:                     [  0,   1,   4,   6,   8,  10],
    NOPAT:                   [-10,   4,  12,  18,  23,  29],
    Capex:                   [ 30,   1,   1,   1,   1,   1],
    "Delta Working Capital": [  3,   0,   1,   1,   2,   2],
    "Unlevered FCF":         [-42,   5,  12,  18,  22,  28],
  },
  results: { npv: 14.7, irr: 0.222, payback: 3.3 },
  narration:
    "IRR of 22.2% clears the hurdle by 720bps, but NPV of $14.7M is ~60% below the buy path. Higher capital efficiency, materially lower absolute return.",
};

export const MODELS: Record<FinancialMode, FinancialModel> = {
  build: BUILD,
  buy: BUY,
  partner: PARTNER,
};

export const DEFAULT_MODE: FinancialMode = "build";
