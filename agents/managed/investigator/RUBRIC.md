# Investigator outcomes rubric

> Template — sent to `user.define_outcome` per session with placeholders
> substituted. STORY-005 ships this skeleton; STORY-020 calibrates the
> wording on a 10-leaf sample to hit a useful pass rate (target ≥0.6 first-
> pass pass to ensure the grader catches weak outputs).
>
> Placeholders the per-session caller substitutes:
>
> - `{{falsifier}}` — what would prove this hypothesis false
> - `{{threshold_metric}}`, `{{threshold_value}}` — quantitative target
> - `{{hypothesis_claim}}` — short claim the leaf is testing

## Pass conditions

The investigator's work is *satisfied* only when ALL five criteria below
are met. The grader scores each independently and returns per-criterion
feedback on revision.

### 1. Addresses the falsifier directly

The artifact and / or final reply must speak to the specific falsifier:

> {{falsifier}}

If the work doesn't engage with the falsifier — even if it's good
analysis on a related question — this fails.

> **Selection-correction nudge.** If criterion 1 fails, the agent should
> explicitly consider whether the *method* it picked was the right one
> for this falsifier. Reviewing the available skills and trying a
> different approach on revision is the correct response — not just
> patching the same artifact.

### 2. Threshold question is answered

The reply must state, in plain language, whether the threshold is met,
not met, partially tested, or not directly tested:

> Threshold: {{threshold_metric}} = {{threshold_value}}

Acceptable phrasings: "above the threshold", "below by N%", "insufficient
data — would need X to determine".

### 3. Quantitative claims have lineage

Every numeric figure the investigator states must be traceable to either:

- a citation (URL, document ID + page, or `source_id` from
  `retrieve_documents`), OR
- a computed lineage (a formula or script the agent ran, with all input
  values themselves either cited or computed)

Bare assertions of numbers ("the market is ~$8B") fail this criterion
without one of the two backings.

### 4. Confidence is calibrated to evidence strength

Confidence must respect these caps:

- ≤ 0.6 if the answer rests on a single point estimate without
  sensitivity analysis.
- ≤ 0.8 if the answer rests on a bottoms-up model with sensitivity on
  the dominant assumption.
- > 0.85 requires multiple independent lines of evidence (e.g., model +
  analog case + market data converging).

The grader reads the reasoning trace; obvious miscalibration (e.g.,
confidence 0.9 on one cited number) fails.

### 5. At least one rejected alternative is named

The reasoning trace, or the final summary's `REJECTED_ALTERNATIVES`
section, must name at least one method, skill, or analytical approach
the agent considered and rejected, with the reason. Examples:

- "Considered comparable-transactions analog, rejected — insufficient
  public comps in the intelligent-PDU segment."
- "Considered top-down sizing, rejected — too coarse for an IRR test."

This is the auditability story; without it, the investigator is a black
box.

## Failure handling

When the grader fails any criterion, it returns the failed criterion
number and a one-sentence explanation. The agent revises and the loop
continues, capped at `max_iterations` (set per session, default 3).

If the agent reaches `max_iterations_reached` without satisfying, the
orchestrator reads the last revision attempt as the final answer and
flags the case for human review.
