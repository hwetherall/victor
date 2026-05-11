# Researcher outcomes rubric

> Template — sent to `user.define_outcome` per session with placeholders
> substituted. STORY-017 ships this as the final wording (the four
> conditions are mechanical enough that calibration is light); STORY-021
> calibrates against a 5-question test set if needed.
>
> Placeholders the per-session caller substitutes:
>
> - `{{question}}` — the research question
> - `{{confidence_target}}` — defaults to 0.8 if omitted
> - `{{max_searches}}` — defaults to 10
> - `{{diminishing_returns_threshold}}` — defaults to 3

## Pass conditions

> **Where the block must live (read this first).** All four conditions
> below are evaluated against the structured block in your **final
> `agent.message` text** — the very last message you send before the
> session idles. Files in `/mnt/session/outputs/` are working artifacts
> and DO NOT count for grading; only the final-message text does. If you
> wrote the block to a file but your final message is a status report
> ("the research task is complete..."), the rubric fails on every
> criterion that needs to read the block.

The Researcher's work is *satisfied* only when ALL four criteria below
are met. The grader scores each independently and returns per-criterion
feedback on revision.

### 1. At least one citation with quote (HARD — LEGAL-003)

The `CITATIONS:` block MUST contain at least one entry, and each entry
MUST have:

- a real URL (not a placeholder, not "n/a", not "(internal)"),
- a title (not just the URL),
- a verbatim quote (≤ 40 words) supporting the answer.

Empty citations or any entry missing url/title/quote fails this
criterion regardless of how well-reasoned the prose is.

> Why: the caller surfaces citations to the case's end users (Daniel /
> partner clients). Without a chain of evidence, a research answer is
> indistinguishable from a hallucination — and exposes the firm to
> publisher-ToS issues from the implicit aggregation pattern.

### 2. `STOPPED_BECAUSE` is one of three valid options

The final block must include `STOPPED_BECAUSE:` set to exactly one of:

- `answered` — confidence ≥ {{confidence_target}} reached with
  citations covering each claim.
- `diminishing_returns` — {{diminishing_returns_threshold}}
  consecutive searches returned no new relevant information.
- `cap_reached` — search budget of {{max_searches}} was exhausted.

Free-form values, missing field, or any other token fails.

### 3. Search path shows query diversity

The `SEARCH_PATH:` list must show meaningfully different queries — no
two queries may share more than 3 consecutive words. Repeating
"intelligent PDU segment margin data center" three times signals the
agent is stuck rephrasing rather than re-orienting.

This is the single most important calibration knob: without it, the
Researcher gets stuck early and burns the search budget on rewordings.

### 4. Confidence calibrated to stopping reason

If `STOPPED_BECAUSE = answered`, `CONFIDENCE` must be ≥ 0.6 (the agent
claimed the answer is in hand — back it up with non-trivial confidence).

If `STOPPED_BECAUSE = cap_reached` or `diminishing_returns`, any
`CONFIDENCE` is acceptable (acknowledging incomplete evidence is fine
and preferable to inflating).

## Failure handling

When the grader fails any criterion, it returns the failed criterion
number and a one-sentence explanation. The Researcher revises and the
loop continues, capped at `max_iterations` (set per session, default 3
— Researcher loops are tight enough that 3 is plenty).

If `max_iterations_reached` without satisfying, the caller treats the
last revision attempt as the final answer. The Investigator's reasoning
trace records the un-satisfied state so the leaf-level confidence
reflects the weaker evidence.
