# Project: Agent Victor v3 — Quality Pass

> **Status:** Development plan. Authored 2026-05-06 from `improve.md` (the v3 spec). Owned by AV-00.
> **Predecessor:** `improve.md` (eight-change spec).
> **Format:** Standard system-analyst breakdown — epics, stories, dependencies, sequencing.

---

## Summary

Convert the eight independent changes in `improve.md` into eight epics. Each epic is independently shippable and ships user-recognizable value (per the spec's own framing), so the 1:1 epic mapping holds. Stories are seeded from each change's "File paths" section: typically one story per file area, sized 0.5–2 days. The whole pass is ~5.5 dev-days. Demo-blockers (EPIC-V3-02, -04, -05, -08) are ~1.5 days and form the critical path to the next demo with Daniel.

The plan honors the spec's prescribed execution order in §11 (demo-blockers first, then high-leverage stretch, then deferred). Three open questions from spec §13 are surfaced as clarifications that gate three specific epics — those stories are tagged `blocked_by_clarification`.

---

## Assumptions

1. **v1 + v2 are built.** The spec's referenced files (`agents/evidence/web-search.ts`, `agents/tree-builder.ts`, `lib/schema.ts`, `components/DecisionCard.tsx`, etc.) are presumed-existing modify targets, not green-field creates.
2. **Single-developer execution.** Story sizing assumes one engineer; the day estimates in `improve.md` §2 were authored on that basis and are carried through.
3. **Effort and demo priority from the spec are authoritative.** Re-estimating from scratch is out of scope.
4. **The ABB run `88a5a3b8` is the regression baseline.** Acceptance criteria reference its outputs (e.g. SH4.2 at 0.35, SH2.2 at 0.22, the four `met` thresholds).
5. **Frameworks remain config-only.** No new framework yaml beyond `ge-9-box-with-make-buy-ally`.
6. **No CI / monitoring / scaffolding stories are added.** This is a quality pass on existing code, not a green-field build.
7. **Tier 2 will not fire on the ABB case in the v3 re-run.** Rolled confidence < 0.6 today; EPIC-V3-07 sets up correctness for future runs but is not exercised end-to-end this pass.

---

## Open Questions / Clarifications Needed

These three are lifted directly from `improve.md` §13. Each gates a specific epic — listed for visibility, repeated against the affected stories below.

| ID | Question | Owner | Blocks |
| --- | --- | --- | --- |
| **Q1** | Stake demotion rule: one-step is the default. Is two-step ever right? Is the rule symmetric (does `pre-disposed-against` evidence get a step-up if it agrees with the bias direction)? | Product (Harry) | EPIC-V3-03 |
| **Q2** | Three-state decision vocabulary (`pursue` / `do-not-pursue` / `insufficient-evidence`) — lock the v3 vocabulary now, or reserve room for `pursue-with-conditions` / `defer-pending-event`? | Product (Harry) | EPIC-V3-05 |
| **Q3** | Query template scope — per-case (`cases/<id>/query-templates.yaml`), per-framework (`frameworks/<id>/query-templates.yaml`), or global with override? Spec recommends per-framework with case overrides. | Architecture (AV-00) | EPIC-V3-01 |

No additional clarifications were introduced beyond these three. The spec is unusually complete on file paths, acceptance criteria, and dependencies.

---

## Epic Overview & Dependency Map

```
EPIC-V3-02 (weights)        ─── independent, ship first
EPIC-V3-04 (labels)         ─── independent
EPIC-V3-07 (mode dep.)      ─── independent (no demo payoff)
EPIC-V3-08 (thresholds)     ─── reads naturally with 01 + 06
EPIC-V3-01 (test-driven Q)  ─── independent (Q3 gates start)
EPIC-V3-03 (stake)          ─── independent (Q1 gates start)
EPIC-V3-06 (gaps)           ─── independent
EPIC-V3-05 (headline)       ─── DEPENDS ON EPIC-V3-06 (consumes gapClosingAction)
                                Q2 gates start
```

Critical path to the next demo: **02 → 04 → 08 → 06 → 05** (06 must precede 05 because the headline's gap list pulls from 06's field).

---

## EPIC-V3-01: Test-driven evidence query generation

**User Value:** Evidence retrieved on each sub-hypothesis actually addresses its falsifier test, not just the topic. Closes the SH4.2-style failure mode where six items of qualitative market growth came back for an NPV threshold question.
**Source:** `improve.md` §3.
**Demo priority:** High (high-leverage stretch, not demo-blocker).
**Estimated Total Effort:** 1.5 d.
**Dependencies:** None on other epics. **Blocked by clarification Q3** (template scope).

### Stories

#### STORY-V3-01-A: Author query templates yaml
- **Type:** Technical Story
- **Statement:** As a framework author, I need a yaml of test-type-specific query templates keyed by metric name so query generation can be tuned without redeploy.
- **Acceptance Criteria:**
  - [ ] File location resolved per Q3 (recommended: `frameworks/ge-9-box-with-make-buy-ally/query-templates.yaml` with case override at `cases/<id>/query-templates.yaml`)
  - [ ] Templates cover at least the 11 test variables surfaced in run `88a5a3b8`: `npv_at_hurdle`, `approved_vendor_status_count`, `dc_distribution_penetration`, `intelligent_segment_share`, `blended_gross_margin`, plus the remaining six
  - [ ] Each template entry produces 3–5 query strings parameterised by the test's `metric`, `target`, `horizon`
  - [ ] Templates are inspectable yaml, not embedded code
- **Complexity:** Medium (template authoring is the actual product investment — spec §3 notes)
- **Dependencies:** None
- **Blocked by clarification:** Q3

#### STORY-V3-01-B: Implement `buildTestDrivenQueries()` in `lib/query-builder.ts`
- **Type:** Technical Story
- **Statement:** As the evidence agent, I need a function that consumes a `HypothesisContent.test` and returns 3–5 templated queries.
- **Acceptance Criteria:**
  - [ ] New file `lib/query-builder.ts` exports `buildTestDrivenQueries(content: HypothesisContent, ctx: CaseContext): string[]`
  - [ ] Returns 3–5 queries seeded by `test.type`, `test.metric`, `test.target`, `test.horizon`
  - [ ] Falls through to a generic claim-based query when `test` is missing or has no matching template
  - [ ] Unit tested against the 11 v1 test variables
- **Complexity:** Medium
- **Dependencies:** STORY-V3-01-A

#### STORY-V3-01-C: Wire into `agents/evidence/web-search.ts`
- **Type:** Technical Story
- **Statement:** As the web evidence pipeline, I should call `buildTestDrivenQueries()` first; v2 Mistral expansion runs only when `test` is missing/generic.
- **Acceptance Criteria:**
  - [ ] `gatherWebEvidence()` replaces its current `buildQuery()` call with `buildTestDrivenQueries()`
  - [ ] STORY-B2 Mistral `expandQueries()` becomes a fallback path
  - [ ] No regression on sub-hypotheses that already had useful evidence in run `88a5a3b8`
- **Complexity:** Small
- **Dependencies:** STORY-V3-01-B

#### STORY-V3-01-D: Acceptance regression on ABB run
- **Type:** Test Story
- **Statement:** Re-run ABB case post-implementation; verify spec acceptance criteria.
- **Acceptance Criteria:**
  - [ ] SH4.2: ≥ 2 evidence items mention IRR / NPV / payback or comparable plant-economics datapoints
  - [ ] SH3.2: ≥ 1 evidence item names a specific hyperscaler vendor list or framework agreement
  - [ ] SH2.2: ≥ 1 evidence item is a teardown / spec comparison vs Vertiv / Schneider / Eaton
  - [ ] Evaluator rationale no longer reads "no evidence directly addresses the threshold" unless test is genuinely not publicly answerable (in which case Change 6's gap mechanism takes over)
- **Complexity:** Small
- **Dependencies:** STORY-V3-01-C

---

## EPIC-V3-02: Case-config weight override fix

**User Value:** The hypothesis weights configured per case actually take effect; the rolled confidence reflects the case author's intent.
**Source:** `improve.md` §4.
**Demo priority:** Demo blocker (silent math bug — ship first).
**Estimated Total Effort:** 0.25 d.
**Dependencies:** None.

### Stories

#### STORY-V3-02-A: Rename case yaml keys to slot ids (Option A)
- **Type:** Technical Story
- **Statement:** As the tree builder, I need case yaml keys that match framework slot ids exactly so `caseWeights[slot.id]` resolves.
- **Acceptance Criteria:**
  - [ ] `cases/abb-rack-pdu.yaml` renames `marketSize` / `techResilience` / `roi` / `timeToMarket` / `strategicFit` to `market-attractive` / `tech-resilient` / `financials-clear` / `can-reach` / `can-win`
  - [ ] Loading the case yaml + rendering the tree produces hypothesis nodes with the spec-defined weights
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-02-B: Re-balance weights to sum to 1.00
- **Type:** Technical Story
- **Statement:** Replace the 1.05-summing weights with `marketSize 0.25 / techResilience 0.20 / roi 0.20 / timeToMarket 0.15 / strategicFit 0.20`.
- **Acceptance Criteria:**
  - [ ] Weights sum to 1.00 pre-normalization
  - [ ] Decision card shows weights summing to 1.00
- **Complexity:** Small
- **Dependencies:** STORY-V3-02-A

#### STORY-V3-02-C: Unit test in `tests/tree-builder.test.ts`
- **Type:** Test Story
- **Statement:** Lock the fix with a test so this regression cannot silently return.
- **Acceptance Criteria:**
  - [ ] Test asserts `H5.weight === 0.25` after build for the ABB case
  - [ ] Test asserts hypothesis weights sum to 1.00
- **Complexity:** Small
- **Dependencies:** STORY-V3-02-B

---

## EPIC-V3-03: Stake-aware evidence weighting

**User Value:** Supportive evidence from a pre-disposed source is visibly de-rated; the decision rationale references stake when material. The stake-tagged-documents non-negotiable becomes load-bearing instead of decorative.
**Source:** `improve.md` §5.
**Demo priority:** Medium (defer to v3.5 per §11 — substantive but invisible without explanation).
**Estimated Total Effort:** 1 d.
**Dependencies:** None on other epics. **Blocked by clarification Q1** (demotion rule).

### Stories

#### STORY-V3-03-A: Extend `EvidenceContent` with `sourceStake`
- **Type:** Technical Story
- **Statement:** Add `sourceStake?: 'neutral-advocate' | 'pre-disposed-favourable' | 'pre-disposed-against' | 'third-party'` to the schema.
- **Acceptance Criteria:**
  - [ ] `lib/schema.ts` carries the new optional field
  - [ ] Type compiles; existing evidence rows backfill cleanly with `third-party` default for web sources
- **Complexity:** Small
- **Dependencies:** None
- **Blocked by clarification:** Q1

#### STORY-V3-03-B: Apply demotion rule in `agents/evidence/scorer.ts`
- **Type:** Technical Story
- **Statement:** After the LLM strength score, deterministically demote supporting evidence from `pre-disposed-favourable` sources by one step (mirror for `pre-disposed-against`).
- **Acceptance Criteria:**
  - [ ] Pulls source stake from the document at scoring time
  - [ ] Applies one-step demotion (`strong → moderate`, `moderate → weak`); contradicting evidence unchanged
  - [ ] Mirror rule applied for `pre-disposed-against`
  - [ ] Every evidence item from `abb-rack-pdu-deck.pdf` previously scored `for / strong` is now `for / moderate` post-rerun
- **Complexity:** Medium
- **Dependencies:** STORY-V3-03-A
- **Blocked by clarification:** Q1

#### STORY-V3-03-C: "Biased source" badge in `components/EvidenceList.tsx`
- **Type:** UI Story
- **Statement:** As a reader, I see a visible badge on any evidence row where source stake conflicts with support direction.
- **Acceptance Criteria:**
  - [ ] Badge renders on supporting evidence from `pre-disposed-favourable` sources (and mirror)
  - [ ] Badge is part of the drill-down view (preserves the demo non-negotiable)
  - [ ] At least one badge visible on the ABB re-run
- **Complexity:** Small
- **Dependencies:** STORY-V3-03-A

#### STORY-V3-03-D: Surface stake in evaluator prompt
- **Type:** Technical Story
- **Statement:** The evaluator (`agents/evaluate.ts`) sees stake-adjusted strengths and is asked to mention bias explicitly when material.
- **Acceptance Criteria:**
  - [ ] Evaluator prompt includes per-item adjusted strength + stake
  - [ ] Decision rationale references the deck's stake when the deck contributed materially (regression check vs ABB re-run)
- **Complexity:** Small
- **Dependencies:** STORY-V3-03-B

---

## EPIC-V3-04: Label resolution + truncation

**User Value:** No more UUIDs in user-visible callouts; no more mid-word truncation in card titles. The output looks like a finished tool, not a debug dump.
**Source:** `improve.md` §6.
**Demo priority:** Demo blocker (pure polish — the run looks unprofessional otherwise).
**Estimated Total Effort:** 0.25 d.
**Dependencies:** None.

### Stories

#### STORY-V3-04-A: `lib/text.ts` with `truncateAtWordBoundary()`
- **Type:** Technical Story
- **Statement:** A reusable helper that truncates at the last space ≤ `max−3` chars, appends `…`.
- **Acceptance Criteria:**
  - [ ] Helper exported from `lib/text.ts`
  - [ ] Unit test covers boundary cases (no space, exact-fit, very short input)
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-04-B: Apply helper in `agents/tree-builder.ts`
- **Type:** Technical Story
- **Statement:** Replace `substring(0, 60)` with `truncateAtWordBoundary()`.
- **Acceptance Criteria:**
  - [ ] No card title in the rendered tree ends mid-word in the ABB re-run
- **Complexity:** Small
- **Dependencies:** STORY-V3-04-A

#### STORY-V3-04-C: Set `weakestLinkLabel` in `agents/decide.ts`
- **Type:** Technical Story
- **Statement:** Decision content carries a label alongside the node id so renderers can show human-readable references.
- **Acceptance Criteria:**
  - [ ] `lib/schema.ts` `DecisionContent` gains `weakestLinkLabel?: string`
  - [ ] `decide.ts` populates the label from the leaf node at emit time
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-04-D: Render label in `DecisionCard.tsx` + markdown export path
- **Type:** UI Story
- **Statement:** Weakest-link callout shows label; clicking the label drills to the node via id (preserves drill-down).
- **Acceptance Criteria:**
  - [ ] Decision card shows label, not UUID
  - [ ] Markdown export of the run shows labels for weakest-link references
  - [ ] Drill-down click path still resolves correctly (the demo non-negotiable)
- **Complexity:** Small
- **Dependencies:** STORY-V3-04-C

---

## EPIC-V3-05: Decision headline framing

**User Value:** The headline distinguishes "test answered, answer was no" from "test not answered". A reader doesn't lock in on a false `Do not pursue` when the real answer is `Below confidence threshold — close diligence gaps`.
**Source:** `improve.md` §7.
**Demo priority:** Demo blocker.
**Estimated Total Effort:** 0.5 d.
**Dependencies:** **EPIC-V3-06** (consumes `gapClosingAction` field for the gap list). **Blocked by clarification Q2** (vocabulary lock).

### Stories

#### STORY-V3-05-A: Three-state schema in `lib/schema.ts`
- **Type:** Technical Story
- **Statement:** `DecisionContent.finalDecision` accepts `'pursue' | 'do-not-pursue' | 'insufficient-evidence'`.
- **Acceptance Criteria:**
  - [ ] Schema updated; type checks across consumers
- **Complexity:** Small
- **Dependencies:** None
- **Blocked by clarification:** Q2

#### STORY-V3-05-B: Three-state logic in `agents/decide.ts`
- **Type:** Technical Story
- **Statement:** Opus prompt asks for one of three states; deterministic post-check verifies against the contradicting-evidence ratio at low-confidence leaves.
- **Acceptance Criteria:**
  - [ ] If Opus picks `do-not-pursue` but no leaf has substantial contradicting evidence, force `insufficient-evidence`
  - [ ] ABB re-run produces `insufficient-evidence` (not `do-not-pursue`)
  - [ ] Synthetic regression test: manually inserting `against / strong` evidence on H1 produces `do-not-pursue`
- **Complexity:** Medium
- **Dependencies:** STORY-V3-05-A
- **Blocked by clarification:** Q2

#### STORY-V3-05-C: Render three states in `DecisionCard.tsx`
- **Type:** UI Story
- **Statement:** Each state has distinct color, icon, copy. `insufficient-evidence` renders as "Below confidence threshold — close diligence gaps" with the gap list inline below.
- **Acceptance Criteria:**
  - [ ] Three visually distinct headline treatments
  - [ ] Gap list (sourced from EPIC-V3-06's `gapClosingAction` aggregation) appears as a distinct UI element below the headline
- **Complexity:** Small
- **Dependencies:** STORY-V3-05-A, EPIC-V3-06 complete

---

## EPIC-V3-06: Gap-closing prescriptions

**User Value:** A user reading a low-confidence sub-hypothesis walks away with a research workplan, not just a verdict. Transforms Agent Victor from a verdict tool into an iterative research tool — the most product-defining of the eight changes.
**Source:** `improve.md` §8.
**Demo priority:** Medium (high-leverage stretch — strongest new product feature, marketing point).
**Estimated Total Effort:** 1 d.
**Dependencies:** None on other epics. Pairs with EPIC-V3-05 (which consumes its output).

### Stories

#### STORY-V3-06-A: Add `gapClosingAction` to `EvaluationContent` schema
- **Type:** Technical Story
- **Statement:** Optional string field on the evaluation, populated only when confidence < 0.5.
- **Acceptance Criteria:**
  - [ ] `lib/schema.ts` updated
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-06-B: Extend evaluator prompt and JSON output
- **Type:** Technical Story
- **Statement:** When the evaluator finishes a sub-hypothesis at confidence < 0.5, it emits a single sentence naming the artefact or data type that would close the gap.
- **Acceptance Criteria:**
  - [ ] All sub-hypotheses with confidence < 0.5 in the ABB re-run carry a non-empty `gapClosingAction`
  - [ ] Spec-quality examples emerge for SH4.2 (bottom-up investment model), SH2.2 (teardown comparison), SH5.2 (OCP/ODCC roadmap)
- **Complexity:** Medium
- **Dependencies:** STORY-V3-06-A

#### STORY-V3-06-C: "To close this gap" callout in `HypothesisCard.tsx`
- **Type:** UI Story
- **Statement:** When `gapClosingAction` is present on a leaf, the card surfaces it as a callout.
- **Acceptance Criteria:**
  - [ ] Callout renders for all leaves with the field; absent otherwise
- **Complexity:** Small
- **Dependencies:** STORY-V3-06-A

#### STORY-V3-06-D: Aggregate gap list for `DecisionCard.tsx`
- **Type:** UI Story
- **Statement:** Decision card aggregates `gapClosingAction` across low-confidence leaves, deduplicated and grouped by parent hypothesis.
- **Acceptance Criteria:**
  - [ ] Gap list visible on the decision card when state is `insufficient-evidence`
  - [ ] Grouped by parent hypothesis
  - [ ] Consumed by EPIC-V3-05's headline UI
- **Complexity:** Small
- **Dependencies:** STORY-V3-06-B

---

## EPIC-V3-07: Mode-dependence on Tier-1 templates

**User Value:** Tier-1 evidence carries the build/buy/partner tag forward, so when Tier 2 fires (in a future run after Changes 1, 3 land), the mode-selection reasoning can reference mode-tagged evidence instead of treating every leaf as agnostic.
**Source:** `improve.md` §9.
**Demo priority:** Low (zero demo payoff until Tier 2 fires — defer to v3.5 per §11).
**Estimated Total Effort:** 0.5 d.
**Dependencies:** None.

### Stories

#### STORY-V3-07-A: Add `modeDependence` to `frameworks/ge-9-box-with-make-buy-ally.yaml`
- **Type:** Technical Story
- **Statement:** Each decomposition entry carries an explicit mode tag per spec §9.
- **Acceptance Criteria:**
  - [ ] All 9 decomposition entries carry the spec's prescribed `modeDependence` value
  - [ ] At least 4 of 11 sub-hypotheses post-build are non-`agnostic`
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-07-B: Propagate in `agents/framework-binder.ts`
- **Type:** Technical Story
- **Statement:** Replace the hardcoded `agnostic` with template propagation.
- **Acceptance Criteria:**
  - [ ] `HypothesisContent.modeDependence` populated from template, not hardcoded
- **Complexity:** Small
- **Dependencies:** STORY-V3-07-A

---

## EPIC-V3-08: Threshold display — value vs target

**User Value:** Each threshold shows what was actually observed (numeric, "not directly tested", "partially tested") instead of a misleading boolean `met`. The user sees how thin the evidence base actually is — which is the right outcome.
**Source:** `improve.md` §10.
**Demo priority:** Demo blocker (biggest single credibility lift per dev-day).
**Estimated Total Effort:** 0.5 d.
**Dependencies:** Reads naturally with EPIC-V3-01 (more thresholds get tested) and EPIC-V3-06 (more get explicit gap actions). No hard dependency.

### Stories

#### STORY-V3-08-A: Threshold record schema in `lib/schema.ts`
- **Type:** Technical Story
- **Statement:** `DecisionContent.thresholds` becomes `{ target, observed, status, sourceLeafIds }[]` instead of `{ name: boolean }`.
- **Acceptance Criteria:**
  - [ ] Schema typed; `status` accepts `'met' | 'not-met' | 'not-directly-tested' | 'partially-tested'`
- **Complexity:** Small
- **Dependencies:** None

#### STORY-V3-08-B: Emit per-threshold records in `agents/decide.ts`
- **Type:** Technical Story
- **Statement:** Decision agent extracts numeric observations when present; falls through to the non-numeric statuses based on the contributing leaves.
- **Acceptance Criteria:**
  - [ ] ABB re-run shows `irrHurdle: target 15% / observed: not directly tested (see SH4.2)`
  - [ ] A threshold reads `met` only when a numeric observation exists and clears the target
  - [ ] `sourceLeafIds` is populated for drill-down
- **Complexity:** Medium
- **Dependencies:** STORY-V3-08-A

#### STORY-V3-08-C: Render records in `DecisionCard.tsx` with drill-down
- **Type:** UI Story
- **Statement:** Each threshold row renders target / observed / status; clicking a row drills to its source leaves.
- **Acceptance Criteria:**
  - [ ] Drill-down click path from a threshold row leads to the sub-hypothesis(es) that informs it (preserves the demo non-negotiable)
- **Complexity:** Small
- **Dependencies:** STORY-V3-08-B

---

## Recommended Execution Order

Per `improve.md` §11, execute in this order. Demo-blockers first; high-leverage stretch second; deferred third.

### Tranche 1 — Demo blockers (~1.5 d, ship before next demo)

1. **EPIC-V3-02** — silent math bug; ship first to fix the rolled-confidence calculation
2. **EPIC-V3-04** — pure polish; the run looks unprofessional otherwise
3. **EPIC-V3-08** — biggest single credibility lift per dev-day
4. **EPIC-V3-06** — must precede 05 (provides `gapClosingAction` field)
5. **EPIC-V3-05** — fixes the misleading "Do not pursue" headline; consumes 06's output

   *Note on ordering 06 vs 05:* The spec lists Change 5 as a demo blocker and Change 6 as high-leverage stretch. But Change 5's UI prescription requires Change 6's data field to populate the gap list. Either ship 06 inside the demo-blocker tranche (recommended) or ship 05 with a stub gap list and backfill 06 after.

### Tranche 2 — High-leverage stretch (if a second day is available)

6. **EPIC-V3-01** — biggest leap in answer quality; one full day end-to-end including template authoring

### Tranche 3 — Deferred to v3.5 (post-demo)

7. **EPIC-V3-03** — substantive but invisible without explanation; better in a follow-up demo
8. **EPIC-V3-07** — zero demo payoff until Tier 2 fires

### Parallelization opportunities

- Tranche 1 epics are mostly independent at the epic level — 02, 04, 08 can ship in parallel. 05 and 06 must serialize (06 → 05).
- EPIC-V3-01 and EPIC-V3-03 are independent; if a second engineer is available post-demo, they can run in parallel.
- All three clarifications (Q1, Q2, Q3) can be answered up front in one product sit-down to unblock 03, 05, 01 simultaneously.

---

## Risk & Dependency Summary

### Critical path to next demo

`EPIC-V3-02 → EPIC-V3-04 → EPIC-V3-08 → EPIC-V3-06 → EPIC-V3-05`. If any of these slips, the demo headline regresses to the misleading state from run `88a5a3b8`.

### Highest-risk items

- **EPIC-V3-01 — template authoring.** The spec calls this out explicitly: "Template authoring is the actual product investment here; the runtime change is small." Don't underestimate STORY-V3-01-A. A weak template library produces the same evidence-quality failure mode the change is supposed to fix.
- **EPIC-V3-05 — depends on EPIC-V3-06.** The spec frames 05 as a demo blocker and 06 as stretch, but the dependency runs the other way. Treat them as one bundle for sequencing purposes.
- **Q2 lock-in.** If the three-state vocabulary is wrong, the schema migration in v3.5 (e.g. adding `pursue-with-conditions`) ripples through schema, decide.ts, and DecisionCard. Lock the vocabulary before STORY-V3-05-A starts.

### Low-risk / appropriately deprioritized

- **EPIC-V3-07** is correctly deferred. Tier 2 doesn't fire on the ABB run, so the change has zero visible effect this pass. Sets up correctness for future runs at low cost.
- **EPIC-V3-03** is substantive but invisible without explanation. Spec §11's recommendation to defer to v3.5 is correct — saving it for a follow-up demo lets it be the headline of that demo rather than a footnote of this one.

### Cross-cutting considerations

- **Drill-down preservation.** The demo non-negotiable is the click path Decision → Hypothesis → Sub-hypothesis → Evidence → Source. Stories STORY-V3-04-D (label rendering), STORY-V3-03-C (badge), and STORY-V3-08-C (threshold drill-down) all touch the rendered tree. Verify the click path end-to-end after each lands.
- **Acceptance is anchored to the ABB re-run.** Every epic's acceptance criteria reference run `88a5a3b8` outputs. A re-run is required after each tranche; budget time for it.
- **No CI / observability stories added.** This pass is quality on existing code. If observability gaps emerge during testing (e.g. how to measure evidence-coverage delta pre/post EPIC-V3-01), surface them as v3.5 candidates rather than expanding scope here.

---

*End of v3 plan. Eight epics, 28 stories, ~5.5 dev-days. Next step: resolve Q1–Q3 with Harry, then start Tranche 1.*
