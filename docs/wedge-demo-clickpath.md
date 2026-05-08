# Wedge Demo — Click Path

> Five-step manual verification for STORY-011. Walk this path before any
> rehearsal or live demo. Currently runs against seeded fixture data;
> STORY-023 (pre-bake) replaces the seeder with a real ABB run output.
>
> **Prerequisites:**
> - Next dev server running on `localhost:3000`
> - The `bottoms-up-financial-model` skill is registered (STORY-009 done)
> - At least one V1 ABB run exists in the DB (so the SH4.2 sub-hypothesis
>   node exists with the right `templateId` for the seeder to find)
> - The fixture xlsx is generated:
>   `npx tsx scripts/gen-fixture-xlsx.ts`

## Setup (one command)

```bash
curl -X POST http://localhost:3000/api/dev/seed-wedge-demo
```

Should return `{"ok": true, ...}` with the IDs of the seeded artifacts,
trace, and HITL question. Idempotent — re-runs drop and re-insert.

If you get a 400 with "No SH4.2 sub_hypothesis found", run the V1
orchestrator on the ABB case once first (load `/case/abb-rack-pdu` and
trigger a run from the UI).

---

## The path

### 1. Decision overview

Open **`http://localhost:3000/case/abb-rack-pdu`**.

Verify:
- Kanban renders with the issue tree (Decision → 5 hypotheses → sub-hypotheses).
- A small **`v2`** badge appears next to the hypothesis count in the Issue
  tree header (only if the most recent run was started with
  `LEAF_RUNTIME=v2`; otherwise it shows `v1`).
- Micky's hypothesis annotations still load on the H4 (Unit Economics)
  card — V1 narration is unbroken (non-negotiable per spec §12).

### 2. Drill into Unit Economics

Click the **Unit Economics** hypothesis card.

Verify:
- The hypothesis drilldown renders. React Flow shows the 2 sub-hypotheses
  underneath (margin clearance, IRR/payback).
- The verdict / confidence meter / TestDefinition all render.
- Micky's per-hypothesis annotation card appears (V1 carry-over).

### 3. Drill into IRR & payback (SH4.2)

Click the **IRR and payback** sub-hypothesis.

Verify (top-down, in the order they should appear):
- Header: "IRR and payback" sub-hypothesis label, parent claim, confidence
  meter showing **0.62** (set by the seeder).
- VerdictPanel + TestDefinition render normally.
- Existing **FinancialModelPanel** still appears (the V1 demo prop scoped
  to this leaf — non-negotiable that V2 doesn't break it).
- **Artifact section** with header "Artifact (2 versions)":
  - Version dropdown is visible — defaults to **v2** (latest).
  - Switching to **v1** swaps the rendered xlsx (same file in the demo
    seed, but the metadata expandable section shows different
    `change_reason`).
  - Tab strip shows: **Inputs / Scenarios / NPV bridge / Conclusion**.
    Click each — every tab renders cell values, no `[object Object]`.
  - Conclusion tab shows the verdict line: "PASS: IRR 38.13% clears
    hurdle of 15%". Dominant assumption + confidence cap text appear.
- **Reasoning trace** section with header "Reasoning trace":
  - "Investigator" badge + step count (16) + the seed session_id
    (`sesn_seed_wedge_demo`).
  - "Rejected methods (3)" collapsible at the top — click to expand,
    confirm `comparable-transactions analog`, `top-down sizing`,
    `sensitivity-analysis (as primary method)` all named with reasons.
  - 16 timeline steps in 4 visual categories (TOOL USE / RESULT / MESSAGE
    / OUTCOME). Long contents have a "show all" toggle.
  - "Outcomes evaluations" footer card shows
    `attempt 1 → needs_revision … attempt 2 → satisfied`.
- **Open questions (1)** section with header.
  - Card has the amber "open" badge, type `open`, and three options
    (`bear (40% of plan)`, `base (75% of plan)`, `bull (95% of plan)`).
  - The question text reads "Year-3 channel ramp scenario".

### 4. Existing evidence list

Below the V2 sections, the V1 evidence list still renders. Click any
evidence row.

Verify:
- The source modal opens (V1 path unaffected).
- Web sources show host + URL; PDF sources show title + page number.
- Esc closes the modal.

### 5. Other sub-hypotheses (V1 regression check)

Back out (← hypothesis), then click any sub-hypothesis OTHER than IRR &
payback (e.g., margin clearance under Unit Economics).

Verify:
- The Artifact / Reasoning trace / Open questions sections **do not
  render** (no V2 data on this leaf).
- The evidence list renders normally.
- This confirms the V1 click path is unbroken on leaves the V2 seeder
  didn't touch.

---

## Cleanup

When done verifying, drop the seeded rows:

```sql
delete from artifacts where metadata->>'seed' = 'wedge-demo';
delete from reasoning_traces where trace_id like 'seed:wedge-demo:%';
delete from user_questions
  where question = 'Year-3 channel ramp scenario'
    and case_id in (select id from cases where title ilike '%ABB%Rack%PDU%');
update tree_nodes
  set confidence = null, status = 'pending', model_used = null, trace_id = null
  where trace_id like 'seed:wedge-demo:%';
```

(Re-running the seeder also drops prior seeded rows automatically — only
run the SQL if you want the leaf back to its V1-only state.)

---

## What this demo proves

When this click path is green:

- Drill-down (non-negotiable §12.6) works for V2 leaves.
- ArtifactViewer renders all four xlsx tabs correctly via SheetJS.
- Version dropdown surfaces v1 vs v2 lineage; structured row-level diff
  is intentionally deferred to STORY-026.
- OODA timeline reads 16 mechanically-captured event-level phases plus
  the rubric outcomes grades — proving STORY-007's reasoning-trace write
  path is faithful.
- HITL escalation appears in the question list per spec.
- Mixed V1/V2 leaves render without breakage on either path.

What it doesn't prove (deferred):

- Live agent producing a real artifact end-to-end (prompt-tuning gap
  noted in STORY-010 status).
- Researcher spawn (STORY-017).
- Structured row-level diff between v1 and v2 (STORY-026).
- 0.85 skill-selection accuracy on a 20-leaf eval (STORY-016).
