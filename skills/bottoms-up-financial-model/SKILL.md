---
name: bottoms-up-financial-model
description: Build a bottoms-up financial model in Excel when the falsifier requires comparing a quantitative figure (NPV, IRR, payback period, gross margin, revenue, EBITDA) against a stated target, AND qualitative search alone will not move the answer. Use this for any leaf where the threshold is a number with a clear pass/fail line — for example "NPV at 15% is negative" or "blended margin below 20%". Produces a four-tab xlsx (Inputs / Scenarios / NPV bridge / Conclusion). Do NOT use for capability-gap or brand-permission hypotheses (use competitor-teardown), follow-on sensitivity on an existing model (use sensitivity-analysis), or base-rate / historical-precedent questions (use analog-case-retrieval).
---

# Bottoms-up financial model

## When to choose this skill

Pick this skill when **all** of the following are true:

1. The falsifier names a quantitative threshold (NPV, IRR, payback period,
   margin, revenue, EBITDA, ROIC).
2. A reasonable answer requires building up the number from inputs — unit
   economics, capex schedule, revenue ramp — rather than looking it up.
3. Web search or document retrieval alone wouldn't be decisive (the inputs
   exist in fragments; the *combination* is the work).

Reject this skill when:

- The falsifier is qualitative ("Brand permission for hyperscaler segment").
- A more specific skill fits — sensitivity analysis on an existing model,
  competitor teardown for capability gaps, analog-case retrieval for base
  rates.
- The threshold is binary and a single citation answers it ("Patent expires
  before 2027").

## Output: a four-tab xlsx

You will produce one `.xlsx` artifact with exactly these four tabs, in this
order. The structure is non-negotiable — the auditability of the model
depends on a reader being able to navigate it without a guide.

### 1. Inputs

Every assumption that drives the model. One row per input with columns:
`name`, `value`, `unit`, `source`, `confidence`. Values in this tab are the
ONLY cells the agent should put a literal number into; everything else is
either a formula or a link to this tab.

### 2. Scenarios

Three columns: bear / base / bull. Each scenario overrides a subset of
inputs from the Inputs tab. Surface which inputs change between scenarios
explicitly.

### 3. NPV bridge

Year-by-year cash-flow build. Rows: revenue, COGS, gross profit, SG&A,
EBIT, tax, NOPAT, capex, free cash flow, discounted FCF, cumulative DCF.
A terminal-value row at the horizon. NPV @ WACC and IRR computed at the
bottom.

### 4. Conclusion

Written in plain language. Three things only:

1. The verdict on the falsifier (pass / fail / insufficient — with the
   number that drives it).
2. The dominant assumption (the input that, if wrong, flips the verdict).
3. The next-best test if confidence is below 0.7 (e.g., "sensitivity
   analysis on year-3 revenue ramp would close the gap").

## Color coding

Apply the standard finance-modeling convention:

- **Blue (#0563C1)** — manual input cells. Should appear ONLY in the Inputs
  and Scenarios tabs.
- **Black** — formulas. Default font.
- **Green (#008000)** — links to other sheets within the workbook.
- **Red (#C00000)** — links to external sources (e.g., "see source_id 42").

Mismatches between color and content (a formula in blue, a literal in a
formula cell) are the most common audit smell. Get this right.

## How to actually do it

The skill ships with `scripts/build-model.py` — a Python generator that
produces a valid four-tab xlsx given a JSON inputs blob. Use it as the
starting point unless your case needs structure outside its template.

### Step-by-step

> **Upload-early rule:** as soon as your model produces ANY valid xlsx
> (even with placeholder inputs), call `upload_artifact` immediately.
> Don't wait for refinement. Each subsequent revision is a new version
> via `parent_artifact_id`. Reasoning: stream budgets are finite —
> agents that refine before uploading frequently get terminated mid-
> revision and produce nothing. **First valid build → instant upload →
> then refine.**

1. **Read the falsifier carefully.** Extract: (a) the metric, (b) the
   target value, (c) the horizon. Without these three the skill cannot
   produce a defensible answer.

2. **Check what inputs you have.** Use `retrieve_documents` first to
   ground inputs in the case's existing sources (briefs, decks). Note
   citations — every quantitative claim in your model must have a
   `source` field populated in the Inputs tab. **Don't spend more than
   3 retrieve_documents calls here.** Get to building.

3. **Identify gaps. DO NOT decline to build because data is sparse.**
   Building with placeholder inputs is correct behaviour — the rubric
   rewards transparent low-confidence answers, not silence. For each
   missing input, do ALL of the following that apply:
   - **Use industry average** as a placeholder. Mark `confidence: low`
     in inputs_provenance for that input. Flag it as the dominant
     assumption in the Conclusion tab.
   - **Spawn a Researcher** if multi-page web research would close the
     gap (margins, growth rates, capex benchmarks). The Researcher runs
     in parallel; don't wait — keep building.
   - **Ask the user** via `ask_user` for case-specific judgement calls
     (e.g., "year-3 channel ramp scenario: bear / base / bull?"). This
     is non-blocking; post the question and continue.

   **You MUST proceed to build the model** even when retrieve_documents
   returns empty. The defensible default is industry-average inputs with
   honest confidence ≤ 0.6 in the final summary.

4. **Run `build-model.py`.** Copy `scripts/build-model.py` into the
   sandbox via `read` then write the same content to a sandbox path:

   ```bash
   # The agent has access to the skill files via the
   # /mnt/agent-skills/bottoms-up-financial-model/ mount inside the
   # sandbox. If the skill file isn't available there for any reason,
   # ask the orchestrator to provide build-model.py directly.
   cp /mnt/agent-skills/bottoms-up-financial-model/scripts/build-model.py /mnt/session/outputs/build-model.py
   cat > /mnt/session/outputs/inputs.json <<'JSON'
   { ... your inputs ... }
   JSON
   python /mnt/session/outputs/build-model.py \
     --inputs /mnt/session/outputs/inputs.json \
     --output /mnt/session/outputs/model.xlsx
   ```

5. **Verify the output.** Open the xlsx (read it with openpyxl in Python)
   and check: NPV value matches your hand calc; the Conclusion tab states
   the verdict; no inputs are missing source citations.

6. **Upload via `upload_artifact`. Non-negotiable.** Read `model.xlsx`
   as base64 (`base64 -w 0 /mnt/session/outputs/model.xlsx`), call
   `upload_artifact` with `type: "xlsx"`, the base64 string in
   `content_b64`, and a one-sentence `change_reason` describing what
   inputs the model rests on. If you produced a v2 (after a revision),
   pass the v1's `parent_artifact_id` so the lineage renders in the
   version-diff UI.

   The work is not done until the artifact is uploaded. The agent that
   built a model and didn't upload it has produced nothing — the row in
   the artifacts table is the load-bearing record, not the file in the
   sandbox.

### Required JSON inputs for build-model.py

```json
{
  "horizon_years": 5,
  "revenue_ramp_millions": [5, 25, 75, 120, 160],
  "capex_year0_millions": 30,
  "gross_margin_pct": 0.35,
  "sga_pct_revenue": 0.10,
  "tax_rate": 0.21,
  "wacc": 0.09,
  "irr_hurdle": 0.15,
  "terminal_growth": 0.02,
  "currency": "USD",
  "case_label": "Investment vs ramp — base case",
  "inputs_provenance": [
    {"name": "gross_margin_pct", "value": 0.35, "source": "ABB 10-K segment data, p.42", "confidence": "medium"},
    {"name": "wacc", "value": 0.09, "source": "ABB IR deck, slide 7", "confidence": "high"}
  ]
}
```

`inputs_provenance` is what populates the Inputs tab's source / confidence
columns. Every numeric input that you used must appear there.

## Confidence calibration after the model

This skill alone cannot push leaf confidence above 0.6 (a single point
estimate). To reach 0.8 you need sensitivity analysis on the dominant
assumption — that's the `sensitivity-analysis` skill, applied to your
model as a follow-on. To reach > 0.85 you need multiple lines of evidence
agreeing (e.g., bottoms-up + analog case + market data).

If your model produces a clear pass / fail with confidence 0.6, that is
often enough — the rubric scores "criterion 4: confidence calibrated to
evidence strength" rather than asking for higher confidence.

## Common failure modes

- **Forgetting terminal value.** If horizon < 10 years, terminal value
  often dominates NPV. Always include it.
- **Mixing scenarios.** Bear / base / bull should differ on a stated
  subset of inputs, not redefine everything. Surface the deltas.
- **Anchoring on case docs.** ABB's pitch deck claims will be optimistic
  by stake (`pre-disposed-favourable`). Discount them.
- **Skipping the dominant-assumption call-out.** The Conclusion tab MUST
  name which input drives the verdict. If it isn't named, the rubric
  fails criterion 1 (artifact addresses the falsifier).
