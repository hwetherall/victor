"""Bottoms-up financial model generator for Agent Victor V2.

Run inside the Investigator's sandbox:

    python build-model.py --inputs inputs.json --output model.xlsx

Produces a four-tab xlsx (Inputs / Scenarios / NPV bridge / Conclusion)
matching the structure documented in SKILL.md. The model is deterministic
and reproducible: same inputs.json -> same xlsx bytes (modulo openpyxl's
internal timestamps).

Inputs schema: see SKILL.md `### Required JSON inputs for build-model.py`.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.worksheet import Worksheet


# ─── Color convention (SKILL.md) ─────────────────────────────────────────────

BLUE_INPUT_FONT = Font(color="0563C1")
BLACK_FORMULA_FONT = Font(color="000000")
GREEN_INTERNAL_FONT = Font(color="008000")
RED_EXTERNAL_FONT = Font(color="C00000")

HEADER_FILL = PatternFill("solid", fgColor="DDDDDD")
HEADER_FONT = Font(bold=True)


# ─── Data classes ────────────────────────────────────────────────────────────


@dataclass
class Inputs:
    horizon_years: int
    revenue_ramp_millions: list[float]
    capex_year0_millions: float
    gross_margin_pct: float
    sga_pct_revenue: float
    tax_rate: float
    wacc: float
    irr_hurdle: float
    terminal_growth: float
    currency: str
    case_label: str
    inputs_provenance: list[dict[str, Any]]

    @classmethod
    def from_json(cls, blob: dict[str, Any]) -> "Inputs":
        ramp = list(blob["revenue_ramp_millions"])
        if len(ramp) != int(blob["horizon_years"]):
            raise ValueError(
                f"revenue_ramp_millions has {len(ramp)} entries but horizon_years is "
                f"{blob['horizon_years']}; they must match."
            )
        return cls(
            horizon_years=int(blob["horizon_years"]),
            revenue_ramp_millions=ramp,
            capex_year0_millions=float(blob["capex_year0_millions"]),
            gross_margin_pct=float(blob["gross_margin_pct"]),
            sga_pct_revenue=float(blob["sga_pct_revenue"]),
            tax_rate=float(blob["tax_rate"]),
            wacc=float(blob["wacc"]),
            irr_hurdle=float(blob["irr_hurdle"]),
            terminal_growth=float(blob["terminal_growth"]),
            currency=str(blob.get("currency", "USD")),
            case_label=str(blob.get("case_label", "Bottoms-up financial model")),
            inputs_provenance=list(blob.get("inputs_provenance", [])),
        )


# ─── Sheet builders ──────────────────────────────────────────────────────────


def _set_header(ws: Worksheet, row: int, headers: list[str]) -> None:
    for col, value in enumerate(headers, start=1):
        cell = ws.cell(row=row, column=col, value=value)
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(horizontal="left")


def _autosize(ws: Worksheet, max_col: int, min_width: int = 12) -> None:
    for col in range(1, max_col + 1):
        letter = get_column_letter(col)
        max_len = min_width
        for cell in ws[letter]:
            if cell.value is not None:
                max_len = max(max_len, len(str(cell.value)))
        ws.column_dimensions[letter].width = min(40, max_len + 2)


def build_inputs_tab(wb: Workbook, inp: Inputs) -> dict[str, str]:
    """Write the Inputs tab. Returns a map of input-name → cell address
    (e.g., "wacc" → "Inputs!$B$8") so the NPV bridge can reference them by
    name via defined names."""
    ws = wb.create_sheet("Inputs")
    _set_header(ws, 1, ["Input", "Value", "Unit", "Source", "Confidence"])

    rows = [
        ("horizon_years", inp.horizon_years, "years", "case scope", "high"),
        ("capex_year0_millions", inp.capex_year0_millions, f"M{inp.currency}", "", ""),
        ("gross_margin_pct", inp.gross_margin_pct, "fraction", "", ""),
        ("sga_pct_revenue", inp.sga_pct_revenue, "fraction", "", ""),
        ("tax_rate", inp.tax_rate, "fraction", "", ""),
        ("wacc", inp.wacc, "fraction", "", ""),
        ("irr_hurdle", inp.irr_hurdle, "fraction", "", ""),
        ("terminal_growth", inp.terminal_growth, "fraction", "", ""),
    ]
    # Augment with provenance from JSON.
    prov_map = {p["name"]: p for p in inp.inputs_provenance}
    addresses: dict[str, str] = {}
    for i, (name, value, unit, default_source, default_conf) in enumerate(rows, start=2):
        ws.cell(row=i, column=1, value=name)
        cell = ws.cell(row=i, column=2, value=value)
        cell.font = BLUE_INPUT_FONT
        ws.cell(row=i, column=3, value=unit)
        prov = prov_map.get(name)
        ws.cell(row=i, column=4, value=prov["source"] if prov else default_source)
        ws.cell(row=i, column=5, value=prov["confidence"] if prov else default_conf)
        addresses[name] = f"Inputs!$B${i}"

    # Revenue ramp gets its own sub-section.
    start = len(rows) + 3
    ws.cell(row=start, column=1, value="Revenue ramp").font = HEADER_FONT
    _set_header(ws, start + 1, ["Year", f"Revenue ({inp.currency} M)"])
    for i, value in enumerate(inp.revenue_ramp_millions, start=1):
        r = start + 1 + i
        ws.cell(row=r, column=1, value=i)
        rev_cell = ws.cell(row=r, column=2, value=value)
        rev_cell.font = BLUE_INPUT_FONT
        addresses[f"revenue_year_{i}"] = f"Inputs!$B${r}"

    _autosize(ws, max_col=5)
    return addresses


def build_npv_bridge_tab(
    wb: Workbook, inp: Inputs, addr: dict[str, str]
) -> dict[str, str]:
    """Write the NPV bridge tab. Year-by-year cash flow build with all
    formulas linking back to the Inputs tab. Green font on cross-sheet refs.
    Returns key cell addresses (npv, irr) for the Conclusion tab."""
    ws = wb.create_sheet("NPV bridge")

    years = inp.horizon_years
    cols = ["Line item"] + [f"Year {y}" for y in range(1, years + 1)]
    _set_header(ws, 1, cols)

    line_items = [
        # (name, formula generator) — formula generator takes year index (1-based)
        ("Revenue", lambda y: f"={addr[f'revenue_year_{y}']}"),
        ("COGS", lambda y: f"=-Revenue_Y{y}*(1-{addr['gross_margin_pct']})"),
        ("Gross profit", lambda y: f"=Revenue_Y{y}+COGS_Y{y}"),
        ("SG&A", lambda y: f"=-Revenue_Y{y}*{addr['sga_pct_revenue']}"),
        ("EBIT", lambda y: f"=GrossProfit_Y{y}+SGA_Y{y}"),
        ("Tax", lambda y: f"=-MAX(0,EBIT_Y{y})*{addr['tax_rate']}"),
        ("NOPAT", lambda y: f"=EBIT_Y{y}+Tax_Y{y}"),
        ("Capex", lambda y: f"=-{addr['capex_year0_millions']}" if y == 1 else "=0"),
        ("Free cash flow", lambda y: f"=NOPAT_Y{y}+Capex_Y{y}"),
        (
            "Discount factor",
            lambda y: f"=1/((1+{addr['wacc']})^{y})",
        ),
        ("Discounted FCF", lambda y: f"=FCF_Y{y}*Discount_Y{y}"),
    ]

    line_addrs: dict[str, dict[int, str]] = {}
    for r_idx, (name, fmt) in enumerate(line_items, start=2):
        ws.cell(row=r_idx, column=1, value=name).font = HEADER_FONT
        per_year: dict[int, str] = {}
        for y in range(1, years + 1):
            cell = ws.cell(row=r_idx, column=1 + y, value=fmt(y))
            cell.font = GREEN_INTERNAL_FONT
            cell.number_format = "#,##0.00"
            per_year[y] = f"'NPV bridge'!{cell.coordinate}"
        line_addrs[name] = per_year

    # Fill defined names so formulas read like Revenue_Y1, COGS_Y1, etc.
    short_for = {
        "Revenue": "Revenue",
        "COGS": "COGS",
        "Gross profit": "GrossProfit",
        "SG&A": "SGA",
        "EBIT": "EBIT",
        "Tax": "Tax",
        "NOPAT": "NOPAT",
        "Capex": "Capex",
        "Free cash flow": "FCF",
        "Discount factor": "Discount",
        "Discounted FCF": "DiscountedFCF",
    }
    for name, per_year in line_addrs.items():
        short = short_for[name]
        for y, ref in per_year.items():
            wb.defined_names[f"{short}_Y{y}"] = DefinedName(
                f"{short}_Y{y}", attr_text=ref.replace("'", "")  # openpyxl quirk
            )

    # Terminal value row.
    tv_row = 2 + len(line_items) + 1
    ws.cell(row=tv_row, column=1, value="Terminal value (PV)").font = HEADER_FONT
    last_year = years
    fcf_last_addr = line_addrs["Free cash flow"][last_year]
    discount_last = line_addrs["Discount factor"][last_year]
    tv_cell = ws.cell(
        row=tv_row,
        column=1 + last_year,
        value=(
            f"=({fcf_last_addr}*(1+{addr['terminal_growth']})/"
            f"({addr['wacc']}-{addr['terminal_growth']}))*{discount_last}"
        ),
    )
    tv_cell.font = GREEN_INTERNAL_FONT
    tv_cell.number_format = "#,##0.00"

    # NPV and IRR.
    npv_row = tv_row + 2
    ws.cell(row=npv_row, column=1, value="NPV @ WACC").font = HEADER_FONT
    discounted_fcfs = ",".join(
        line_addrs["Discounted FCF"][y] for y in range(1, years + 1)
    )
    npv_cell = ws.cell(
        row=npv_row,
        column=2,
        value=f"=SUM({discounted_fcfs})+{tv_cell.coordinate.replace('!', '!')}",
    )
    npv_cell.font = BLACK_FORMULA_FONT
    npv_cell.number_format = "#,##0.00"

    irr_row = npv_row + 1
    ws.cell(row=irr_row, column=1, value="IRR (undiscounted FCF)").font = HEADER_FONT
    fcfs_undiscounted = ",".join(
        line_addrs["Free cash flow"][y] for y in range(1, years + 1)
    )
    irr_cell = ws.cell(
        row=irr_row,
        column=2,
        value=f"=IRR(({fcfs_undiscounted}))",
    )
    irr_cell.font = BLACK_FORMULA_FONT
    irr_cell.number_format = "0.00%"

    _autosize(ws, max_col=1 + years)
    return {
        "npv": f"'NPV bridge'!{npv_cell.coordinate}",
        "irr": f"'NPV bridge'!{irr_cell.coordinate}",
    }


def build_scenarios_tab(wb: Workbook, inp: Inputs) -> None:
    """Bear / base / bull scenarios. Differences from base are surfaced as
    multiplicative deltas on the revenue ramp (the most common scenario lever)."""
    ws = wb.create_sheet("Scenarios")
    _set_header(ws, 1, ["Year", "Bear (60% of base)", "Base", "Bull (130% of base)"])
    for y, base in enumerate(inp.revenue_ramp_millions, start=1):
        ws.cell(row=y + 1, column=1, value=y)
        ws.cell(row=y + 1, column=2, value=round(base * 0.6, 2)).font = BLUE_INPUT_FONT
        ws.cell(row=y + 1, column=3, value=base).font = BLUE_INPUT_FONT
        ws.cell(row=y + 1, column=4, value=round(base * 1.3, 2)).font = BLUE_INPUT_FONT

    # Note row explaining the lever.
    note_row = inp.horizon_years + 3
    ws.cell(
        row=note_row,
        column=1,
        value=(
            "Note: scenarios scale the revenue ramp only. To stress-test capex, "
            "margin, or WACC, add additional scenario columns or use the "
            "sensitivity-analysis skill on the resulting NPV."
        ),
    ).font = Font(italic=True, color="666666")
    _autosize(ws, max_col=4)


def build_conclusion_tab(
    wb: Workbook, inp: Inputs, npv_addr: str, irr_addr: str
) -> None:
    ws = wb.create_sheet("Conclusion")
    ws.cell(row=1, column=1, value=inp.case_label).font = Font(bold=True, size=14)

    # Verdict driven by IRR vs hurdle. Use IF formula so the verdict updates
    # when inputs change.
    ws.cell(row=3, column=1, value="Verdict (IRR vs hurdle)").font = HEADER_FONT
    verdict_cell = ws.cell(
        row=3,
        column=2,
        value=(
            f'=IF({irr_addr}>={inp.irr_hurdle},'
            f'"PASS: IRR clears hurdle of {inp.irr_hurdle*100:.0f}%",'
            f'"FAIL: IRR below hurdle of {inp.irr_hurdle*100:.0f}%")'
        ),
    )
    verdict_cell.font = BLACK_FORMULA_FONT

    ws.cell(row=4, column=1, value="NPV @ WACC").font = HEADER_FONT
    ws.cell(row=4, column=2, value=f"={npv_addr}").number_format = "#,##0.00"

    ws.cell(row=5, column=1, value="IRR").font = HEADER_FONT
    ws.cell(row=5, column=2, value=f"={irr_addr}").number_format = "0.00%"

    ws.cell(row=7, column=1, value="Dominant assumption").font = HEADER_FONT
    ws.cell(
        row=7,
        column=2,
        value=(
            "The verdict is most sensitive to the revenue ramp (year 3 onward) "
            "and gross margin. If either is wrong by more than 25%, the "
            "verdict flips. Apply the sensitivity-analysis skill to confirm."
        ),
    )

    ws.cell(row=9, column=1, value="Confidence cap").font = HEADER_FONT
    ws.cell(
        row=9,
        column=2,
        value=(
            "0.6 — single-point estimate without sensitivity. To raise above "
            "0.6, run sensitivity-analysis on the dominant assumption. To "
            "raise above 0.85, find a converging analog case or independent "
            "market data."
        ),
    )

    _autosize(ws, max_col=2, min_width=18)


# ─── Entrypoint ──────────────────────────────────────────────────────────────


def build(inp: Inputs, output_path: str) -> None:
    wb = Workbook()
    # Drop the default empty sheet.
    default = wb.active
    if default is not None:
        wb.remove(default)

    addr = build_inputs_tab(wb, inp)
    build_scenarios_tab(wb, inp)
    npv_irr = build_npv_bridge_tab(wb, inp, addr)
    build_conclusion_tab(wb, inp, npv_irr["npv"], npv_irr["irr"])

    wb.save(output_path)


def main() -> None:
    parser = argparse.ArgumentParser(description="Build a bottoms-up financial model xlsx.")
    parser.add_argument("--inputs", required=True, help="Path to inputs.json")
    parser.add_argument("--output", required=True, help="Path to output xlsx")
    args = parser.parse_args()

    with open(args.inputs, "r") as fh:
        blob = json.load(fh)
    inp = Inputs.from_json(blob)
    build(inp, args.output)
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
