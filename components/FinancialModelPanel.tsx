"use client";

// Animated mocked financial model that mounts above the evidence list when the
// user drills into the `investment-vs-ramp` sub-hypothesis. Three modes
// (Build / Buy / Partner) swap pre-tuned P&L tables; the table fills cell-by-
// cell, the FCF row gets a glow sweep, and result tiles snap in with the IRR
// color-coded against the 15% hurdle. No backend, no LLM call — pure mock.
//
// Animation state machine (per mode change):
//   1. revealedCount: 0 → totalCells (40ms/cell, row-major L→R)
//   2. +200ms       → glowActive = true (FCF row gets emerald ring)
//   3. +500ms       → tilesRevealed = 1 → 2 → 3 (300ms stagger)

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_MODE,
  IRR_HURDLE,
  MODELS,
  MODE_DESCRIPTIONS,
  MODE_LABELS,
  ROW_ORDER,
  SUBTOTAL_ROWS,
  WACC,
  YEAR_LABELS,
  type FinancialMode,
  type RowKey,
} from "@/lib/mock-financial-models";

const CELL_REVEAL_MS = 40;
const GLOW_DELAY_MS = 200;
const TILES_AFTER_GLOW_MS = 500;
const TILE_STAGGER_MS = 300;

const TOTAL_CELLS = ROW_ORDER.length * YEAR_LABELS.length;
const NUM_YEARS = YEAR_LABELS.length;

const MODES: FinancialMode[] = ["build", "buy", "partner"];

export function FinancialModelPanel() {
  const [mode, setMode] = useState<FinancialMode>(DEFAULT_MODE);
  const [revealedCount, setRevealedCount] = useState(0);
  const [glowActive, setGlowActive] = useState(false);
  const [tilesRevealed, setTilesRevealed] = useState(0);

  // Hold every timer ID we spawn so a fast mode-switch can cancel them all.
  // Using refs sidesteps the stale-closure footgun where a stale interval
  // tick keeps incrementing revealedCount after a new mode kicks off.
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutsRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    // Cancel any in-flight animation from the previous mode.
    if (intervalRef.current) clearInterval(intervalRef.current);
    timeoutsRef.current.forEach((t) => clearTimeout(t));
    timeoutsRef.current = [];

    setRevealedCount(0);
    setGlowActive(false);
    setTilesRevealed(0);

    // Cell reveal — row-by-row, left-to-right.
    intervalRef.current = setInterval(() => {
      setRevealedCount((prev) => {
        const next = prev + 1;
        if (next >= TOTAL_CELLS && intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        return Math.min(next, TOTAL_CELLS);
      });
    }, CELL_REVEAL_MS);

    // Glow on FCF row after table is full.
    const glowTimer = setTimeout(
      () => setGlowActive(true),
      CELL_REVEAL_MS * TOTAL_CELLS + GLOW_DELAY_MS,
    );
    timeoutsRef.current.push(glowTimer);

    // Tiles snap in one-by-one after the glow lands.
    const tilesStart = CELL_REVEAL_MS * TOTAL_CELLS + GLOW_DELAY_MS + TILES_AFTER_GLOW_MS;
    for (let i = 1; i <= 3; i++) {
      const t = setTimeout(
        () => setTilesRevealed((n) => Math.max(n, i)),
        tilesStart + (i - 1) * TILE_STAGGER_MS,
      );
      timeoutsRef.current.push(t);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      timeoutsRef.current.forEach((t) => clearTimeout(t));
      timeoutsRef.current = [];
    };
  }, [mode]);

  const model = MODELS[mode];

  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-950">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-neutral-100">
            Financial model
          </h3>
          <p className="mt-1 font-mono text-[11px] text-neutral-500">
            5-year DCF · WACC {Math.round(WACC * 100)}% · hurdle {Math.round(IRR_HURDLE * 100)}%
          </p>
        </div>
        <ModeSelector mode={mode} onChange={setMode} />
      </div>

      <p className="px-4 pt-3 text-xs text-neutral-400">
        {MODE_DESCRIPTIONS[mode]}
      </p>

      <div className="overflow-x-auto px-4 pb-4 pt-3">
        <FinancialTable
          rows={model.rows}
          revealedCount={revealedCount}
          glowActive={glowActive}
        />
      </div>

      <div className="border-t border-neutral-800 px-4 py-4">
        <ResultTiles
          results={model.results}
          revealed={tilesRevealed}
        />
        <Narration text={model.narration} visible={tilesRevealed >= 3} />
      </div>
    </section>
  );
}

// ─── Mode selector ───────────────────────────────────────────────────────────

function ModeSelector({
  mode,
  onChange,
}: {
  mode: FinancialMode;
  onChange: (m: FinancialMode) => void;
}) {
  return (
    <div className="flex gap-1 rounded-md border border-neutral-800 bg-neutral-900 p-1">
      {MODES.map((m) => {
        const active = m === mode;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onChange(m)}
            className={
              active
                ? "rounded-sm border border-emerald-600 bg-emerald-700/20 px-3 py-1 text-xs font-medium text-emerald-200"
                : "rounded-sm border border-transparent px-3 py-1 text-xs font-medium text-neutral-400 hover:text-neutral-200"
            }
          >
            {MODE_LABELS[m]}
          </button>
        );
      })}
    </div>
  );
}

// ─── Table ───────────────────────────────────────────────────────────────────

function FinancialTable({
  rows,
  revealedCount,
  glowActive,
}: {
  rows: Record<RowKey, number[]>;
  revealedCount: number;
  glowActive: boolean;
}) {
  return (
    <table className="min-w-[640px] border-collapse text-xs">
      <thead>
        <tr>
          <th className="sticky left-0 bg-neutral-950 px-2 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-neutral-500">
            Line item ($M)
          </th>
          {YEAR_LABELS.map((y) => (
            <th
              key={y}
              className="px-2 py-2 text-right font-mono text-[10px] uppercase tracking-wider text-neutral-500"
            >
              {y}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROW_ORDER.map((rowKey, rowIdx) => {
          const isSubtotal = SUBTOTAL_ROWS.has(rowKey);
          const isFcf = rowKey === "Unlevered FCF";
          return (
            <tr
              key={rowKey}
              className={
                isSubtotal
                  ? "border-t border-neutral-800"
                  : ""
              }
            >
              <td
                className={
                  "sticky left-0 bg-neutral-950 px-2 py-1.5 " +
                  (isSubtotal
                    ? "font-medium text-neutral-200"
                    : "text-neutral-400")
                }
              >
                {rowKey}
              </td>
              {rows[rowKey].map((value, colIdx) => {
                const cellIndex = rowIdx * NUM_YEARS + colIdx;
                const visible = cellIndex < revealedCount;
                return (
                  <td
                    key={colIdx}
                    className={cellClass(isSubtotal, isFcf, glowActive)}
                  >
                    {visible ? (
                      <span className="font-mono">{formatValue(value)}</span>
                    ) : (
                      <span className="inline-block h-3 w-12 animate-pulse rounded bg-neutral-800" />
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function cellClass(isSubtotal: boolean, isFcf: boolean, glowActive: boolean): string {
  const base = "px-2 py-1.5 text-right transition-all duration-500 ";
  const tone = isSubtotal
    ? "font-medium text-neutral-100 "
    : "text-neutral-400 ";
  const glow = isFcf && glowActive
    ? "bg-emerald-500/10 ring-1 ring-emerald-500/40 "
    : "";
  return base + tone + glow;
}

function formatValue(v: number): string {
  if (v === 0) return "—";
  const abs = Math.abs(v);
  return v < 0 ? `($${abs}M)` : `$${abs}M`;
}

// ─── Result tiles ────────────────────────────────────────────────────────────

function ResultTiles({
  results,
  revealed,
}: {
  results: { npv: number; irr: number; payback: number };
  revealed: number;
}) {
  const passes = results.irr >= IRR_HURDLE;
  const bpsDelta = Math.round((results.irr - IRR_HURDLE) * 10000);
  const bpsLabel = bpsDelta >= 0 ? `+${bpsDelta}bps vs hurdle` : `${bpsDelta}bps vs hurdle`;

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      <Tile
        label={`NPV at ${Math.round(WACC * 100)}% WACC`}
        value={formatNpv(results.npv)}
        unit="USD"
        revealed={revealed >= 1}
      />
      <Tile
        label="IRR"
        value={`${(results.irr * 100).toFixed(1)}%`}
        unit={bpsLabel}
        revealed={revealed >= 2}
        tone={passes ? "pass" : "fail"}
      />
      <Tile
        label="Payback"
        value={results.payback.toFixed(1)}
        unit="years"
        revealed={revealed >= 3}
      />
    </div>
  );
}

function Tile({
  label,
  value,
  unit,
  revealed,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit: string;
  revealed: boolean;
  tone?: "neutral" | "pass" | "fail";
}) {
  const toneClass =
    tone === "pass"
      ? "border-emerald-700 bg-emerald-900/30"
      : tone === "fail"
        ? "border-rose-700 bg-rose-900/30"
        : "border-neutral-800 bg-neutral-900";
  const unitClass =
    tone === "pass"
      ? "text-emerald-400"
      : tone === "fail"
        ? "text-rose-400"
        : "text-neutral-500";
  return (
    <div
      className={
        "rounded-md border p-4 transition-opacity duration-500 " +
        toneClass +
        " " +
        (revealed ? "opacity-100" : "opacity-0")
      }
    >
      <div className="text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <div className="mt-2 font-mono text-2xl text-neutral-50">{value}</div>
      <div className={"mt-1 font-mono text-[11px] " + unitClass}>{unit}</div>
    </div>
  );
}

function formatNpv(v: number): string {
  const abs = Math.abs(v);
  const formatted = abs.toFixed(1);
  return v < 0 ? `($${formatted}M)` : `$${formatted}M`;
}

// ─── Narration ───────────────────────────────────────────────────────────────

function Narration({ text, visible }: { text: string; visible: boolean }) {
  return (
    <p
      className={
        "mt-4 border-l-2 border-neutral-700 pl-3 font-mono text-xs italic leading-relaxed text-neutral-400 transition-opacity duration-500 " +
        (visible ? "opacity-100" : "opacity-0")
      }
    >
      {text}
    </p>
  );
}
