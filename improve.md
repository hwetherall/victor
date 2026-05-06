# Agent Victor v3 — Targeted Evidence, Bias Awareness, and Output Quality

> **Status:** Spec for the v3 quality pass. Authored 2026-05-06 after the first end-to-end run on `abb-rack-pdu` (run `88a5a3b8`). Owned by AV-00.
> **Predecessors:** `SPEC.md` (master), `plan-v2.md` (vision / contrarian / multi-model UI).
> **Scope:** Eight discrete improvements identified from the first run's output. Each is independently shippable. Harry translates these into epics, stories, and tasks downstream.

---

## 1. Mission

The v1 + v2 pipeline produces a structurally correct, multi-model, end-to-end run. The architectural claims hold: tree shape, falsifier framing, gated Tier 2, weighted-product rollup, drill-down click path, vision ingestion, and the contrarian pass all work as specified.

The v3 pass closes the gap between *correct architecture* and *defensible answer*. The first run surfaced eight specific defects in evidence quality, weight handling, bias awareness, and output presentation that, taken together, prevent the system from producing answers that would survive a senior partner's review.

This spec defines those eight changes. Each has a clear owner file, an acceptance test, and a demo-priority tier.

---

## 2. The eight changes at a glance

| # | Title | Demo priority | Effort | Primary files touched |
| --- | --- | --- | --- | --- |
| 1 | Test-driven evidence query generation | High | 1.5 d | `agents/evidence/web-search.ts`, `lib/query-builder.ts` (new) |
| 2 | Case-config weight override fix | Demo blocker | 0.25 d | `agents/tree-builder.ts`, `cases/abb-rack-pdu.yaml` |
| 3 | Stake-aware evidence weighting | Medium | 1 d | `agents/evidence/scorer.ts`, `lib/schema.ts`, `components/EvidenceList.tsx` |
| 4 | Label resolution in exports + truncation fix | Demo blocker | 0.25 d | `agents/tree-builder.ts`, `agents/decide.ts`, export path |
| 5 | Decision headline distinguishes "below threshold" from "negative evidence" | Demo blocker | 0.5 d | `agents/decide.ts`, `lib/schema.ts`, `components/DecisionCard.tsx` |
| 6 | Gap-closing prescriptions on low-confidence leaves | Medium | 1 d | `agents/evaluate.ts`, `lib/schema.ts`, `components/HypothesisCard.tsx` |
| 7 | Mode-dependence restoration on Tier-1 templates | Low (sets up Tier 2) | 0.5 d | `frameworks/ge-9-box-with-make-buy-ally.yaml`, `agents/framework-binder.ts` |
| 8 | Threshold display: value vs target, not boolean | Demo blocker | 0.5 d | `agents/decide.ts`, `lib/schema.ts`, `components/DecisionCard.tsx` |

**Total effort:** ~5.5 dev-days. **Demo blockers:** #2, #4, #5, #8 (~1.5 days). **High-leverage stretch:** #1, #3, #6.

---

## 3. Change 1 — Test-driven evidence query generation

**Problem.** The web evidence agent generates search queries from the hypothesis claim and substitutions. It does not consult the `test` field. Result: SH4.2 ("Investment vs revenue ramp clears 15% IRR hurdle", test = `npv_at_hurdle ≥ 0`) returned six items of qualitative market growth data, none of which addressed NPV. The evaluator's own rationale admits the falsifier was untested. Same pattern at SH2.2 (capability gap, 0.22), SH3.2 (approved vendor count, 0.52), SH5.2 (DC distribution penetration, 0.50).

**Current behaviour.** `gatherWebEvidence()` in `agents/evidence/web-search.ts` builds a query from `claim` + substitutions. The v2 Mistral query expansion (`expandQueries()`) also reads only the claim.

**Target behaviour.** Query generation reads the `test` shape (`type`, `metric`, `target`, `horizon`) from the sub-hypothesis content and produces test-type-specific query templates. Examples:

- `test.type = "threshold"` on `npv_at_hurdle` → queries about competitor capex disclosures, R&D-to-revenue ratios, comparable PDU plant economics, IRR / payback benchmarks for adjacent products
- `test.type = "threshold"` on `approved_vendor_status_count` → queries naming specific hyperscalers (AWS, Azure, GCP, Meta, Oracle) with phrases like "approved vendor list", "preferred supplier", "framework agreement"
- `test.type = "scenario"` on `dc_distribution_penetration` → queries about 800VDC adoption timelines, OCP / ODCC DC-bus standards, hyperscaler power architecture announcements
- `test.type = "comparison"` on `intelligent_segment_share` → queries about segment market-share splits, ASP differentials between basic / metered / switched

**File paths.**

- New: `lib/query-builder.ts` exporting `buildTestDrivenQueries(content: HypothesisContent, ctx: CaseContext): string[]` returning 3–5 queries seeded by `test`
- Modified: `agents/evidence/web-search.ts` — replace the current `buildQuery()` call with `buildTestDrivenQueries()`; the v2 STORY-B2 Mistral expansion becomes a fallback for sub-hypotheses where `test` is missing or generic

**Acceptance criteria.**

- For SH4.2, at least 2 post-run evidence items mention either an IRR / NPV / payback figure or a comparable plant-economics datapoint (not just market size)
- For SH3.2, at least 1 evidence item names a specific hyperscaler vendor list or framework agreement
- For SH2.2, at least 1 evidence item is a teardown, technical spec comparison, or feature matrix versus Vertiv / Schneider / Eaton
- The evaluator rationale for any sub-hypothesis no longer reads "no evidence directly addresses the threshold" *unless* the test genuinely cannot be answered from public sources — in which case the rationale should say "test is not publicly answerable" (a different failure mode, surfaced through Change 6)

**Dependencies.** None. Independent of other v3 changes.

**Notes.** Query templates should live as data, not code — `lib/query-templates.yaml` keyed by metric name. Inspectable, editable, no redeploy needed to tune. Template authoring is the actual product investment here; the runtime change is small.

---

## 4. Change 2 — Case-config weight override fix

**Problem.** SPEC §8 defines H5 (TechResilience) at weight 0.25. The first run shows it at 0.20 — the framework slot default. The case-config override is not propagating to the rendered tree.

**Current behaviour.** `agents/tree-builder.ts` reads `caseWeights[slot.id]` but the case yaml uses keys like `techResilience: 0.25` while slots use ids like `tech-resilient`. The kebab/camel mismatch causes `caseWeights[slot.id]` to be `undefined` for every slot, falling through to `slot.weight`.

**Target behaviour.** Case-config weight keys map cleanly to framework slot ids.

**File paths.**

Two valid approaches; pick one:

- **Option A** — Modify `cases/abb-rack-pdu.yaml`: rename `marketSize`, `techResilience`, `roi`, `timeToMarket`, `strategicFit` to slot ids `market-attractive`, `tech-resilient`, `financials-clear`, `can-reach`, `can-win`. Cleanest long-term.
- **Option B** — Modify `agents/tree-builder.ts`: add a `mapCaseKeysToSlotIds()` helper with an explicit alias table. Backwards-compatible with any existing yaml that uses the camel-case keys.

Recommend Option A. The yaml is currently authored for one case; the migration cost is zero.

**Acceptance criteria.**

- Loading `abb-rack-pdu.yaml` and rendering the tree produces hypothesis nodes with weights `{market-attractive: 0.25, can-win: 0.20, can-reach: 0.15, financials-clear: 0.20, tech-resilient: 0.25}`
- Unit test in `tests/tree-builder.test.ts` asserts `H5.weight === 0.25` after build
- The decision card's hypothesis weights sum to 1.00 after normalization (see notes)

**Dependencies.** None.

**Notes.** SPEC §5 weights as written sum to 1.05, not 1.00. The rollup normalizes (`weightTotal` in `agents/rollup.ts`) so it doesn't cause a math error, but it's a smell. Decide whether to fix the weights to sum to 1.00 in this change or carry the smell. Recommend fixing — `marketSize 0.25, techResilience 0.20, roi 0.20, timeToMarket 0.15, strategicFit 0.20` sums to 1.00 and matches the GE 9-box weighting tradition where strategic fit and tech resilience are commensurate.

---

## 5. Change 3 — Stake-aware evidence weighting

**Problem.** The case yaml records `inputDocs[].stake` (e.g. `pre-disposed-favourable` for the ABB internal deck, `neutral-advocate` for the Innovera brief). Nothing in the evaluator or scorer reads this. Deck-sourced supportive evidence is weighted identically to third-party research, which is exactly the bias the stake field exists to surface.

**Current behaviour.** `agents/evidence/scorer.ts` returns `strength: 'weak' | 'moderate' | 'strong'` based purely on the LLM scorer's read of source content.

**Target behaviour.**

1. Evidence rows carry a `sourceStake?: 'neutral-advocate' | 'pre-disposed-favourable' | 'pre-disposed-against' | 'third-party'` field, populated at scoring time from the source document's stake (defaulting to `third-party` for web sources)
2. The scorer applies a deterministic adjustment: `pre-disposed-favourable` supporting evidence gets one strength step demoted (`strong → moderate`, `moderate → weak`); contradicting evidence from the same source is unchanged. Mirror rule for `pre-disposed-against`
3. The UI surfaces a "biased source" badge on any evidence row where the source stake conflicts with the support direction

**File paths.**

- Modified: `lib/schema.ts` — add `sourceStake` to `EvidenceContent`
- Modified: `agents/evidence/scorer.ts` — pull source stake at scoring time; apply demotion rule deterministically after the LLM scoring step
- Modified: `components/EvidenceList.tsx` — render the badge
- Modified: `agents/evaluate.ts` — include stake-adjusted strength in the evaluator prompt; mention bias explicitly in the rationale when material

**Acceptance criteria.**

- After v3 re-run, every evidence item from `abb-rack-pdu-deck.pdf` previously scored `for / strong` is now `for / moderate`
- The decision card's evidence list shows at least one "biased source" badge
- The decision rationale references the deck's stake explicitly when the deck contributed materially (e.g. "Note: the ABB internal deck is pre-disposed; supporting findings from it are de-rated one step")

**Dependencies.** None.

**Notes.** The demotion rule is intentionally one-step rather than two-step — the deck is a real document; its evidence is not zero-value. The rule can be tuned per-stake in `cases/<id>.yaml` later if needed. See Open Question Q1.

---

## 6. Change 4 — Label resolution in exports + truncation fix

**Problem.** Two issues, one fix:

1. The decision card's "weakest link" callout shows a UUID (`85943eb4-c680-4c7d-bae9-af026703582b`) instead of the hypothesis label
2. Hypothesis card titles are truncated mid-word by `substring(0, 60)` in `agents/tree-builder.ts`: "global data center market, accessible g…", "ABB can access a competitive intelligent Rack PDU within 3 y…", "Existing ABB electrical channels cannot reach IT decision-ma…"

**Target behaviour.**

1. Any rendered reference to a node id resolves to its label
2. Truncation respects word boundaries

**File paths.**

- New: `lib/text.ts` exporting `truncateAtWordBoundary(s: string, max: number): string` (truncate at last space ≤ max−3 chars, append "…")
- Modified: `agents/tree-builder.ts` — replace `substring(0, 60)` with the new helper
- Modified: `agents/decide.ts` — when emitting decision content, set `weakestLinkLabel` alongside `weakestLinkNodeId`
- Modified: `lib/schema.ts` — `DecisionContent` gains `weakestLinkLabel?: string`
- Modified: `components/DecisionCard.tsx` — display label; link the label to the node via id
- Modified: any markdown export path — same resolution

**Acceptance criteria.**

- No card title in the rendered tree ends with a partial word
- The decision card's weakest-link callout shows a human-readable hypothesis label
- The markdown export of a run shows labels, not UUIDs, for weakest-link references

**Dependencies.** None.

**Notes.** The truncator is reusable for any future export path (PowerPoint, PDF, etc.). One-line helper, one place.

---

## 7. Change 5 — Decision headline framing

**Problem.** The first run produced "Decision: Do not pursue rack PDU" with a rationale that says "revisit only after bottom-up roadmap and parity diligence close those two gaps". Headline says "no"; rationale says "not yet". A reader will lock in on the headline.

There is a meaningful distinction between:

- *Negative evidence* — the decision tests were answered, and the answer was "no" (e.g. blended margin came in at 14%, hard miss against 20% threshold)
- *Insufficient evidence* — the decision tests were not answered; the gating threshold was not cleared as a result

The first run is overwhelmingly the second case. The output presents it as the first.

**Target behaviour.** The decision agent emits one of three states:

- `pursue` — rolled confidence ≥ 0.6 (and Tier 2 ran)
- `do-not-pursue` — rolled confidence < 0.6 *and* a majority of sub-hypotheses below the gating threshold are below 0.5 because of contradicting evidence (test answered, answer was "no")
- `insufficient-evidence` — rolled confidence < 0.6 *and* the low-confidence leaves are below 0.5 because of evidence absence (test not answered)

The decision card surfaces the state as the headline. `insufficient-evidence` framing is "Below confidence threshold — close diligence gaps before deciding" with the gap list inline.

**File paths.**

- Modified: `agents/decide.ts` — Opus prompt asks for one of three states; deterministic post-check verifies the choice against the contradicting-evidence ratio at low-confidence leaves (if Opus picks `do-not-pursue` but no leaf has substantial contradicting evidence, force `insufficient-evidence`)
- Modified: `lib/schema.ts` — `DecisionContent.finalDecision` accepts the third state
- Modified: `components/DecisionCard.tsx` — render the three states distinctly (color, icon, copy)

**Acceptance criteria.**

- The ABB run produces `insufficient-evidence` (not `do-not-pursue`) given the current evidence base
- The decision card headline reads "Below confidence threshold — close diligence gaps" or equivalent, not "Do not pursue"
- The gap list (the same content as the rationale's "revisit only after…" sentence) appears as a distinct UI element below the headline
- A synthetic run where contradicting evidence dominates produces `do-not-pursue` correctly (regression-test by manually inserting `against / strong` evidence on H1 and re-evaluating)

**Dependencies.** Reads cleanly with Change 6; the gap list is populated by Change 6's `gapClosingAction` field.

**Notes.** The state machine here is a product decision worth thinking about beyond v3. Obvious extensions: `pursue-with-conditions`, `defer-pending-event`. For v3, three states is enough. See Open Question Q2.

---

## 8. Change 6 — Gap-closing prescriptions on low-confidence leaves

**Problem.** Several sub-hypotheses (SH2.2 at 0.22, SH4.2 at 0.35, SH5.2 at 0.50) have rationales that correctly diagnose evidence gaps but do not prescribe a research action. A user looking at the run learns "we don't know" but not "here's what would close it".

**Target behaviour.** When the hypothesis evaluator finishes a sub-hypothesis with confidence < 0.5, it emits a `gapClosingAction` field describing what evidence would change the answer.

Format: a single sentence naming the artefact or data type. Examples:

- SH4.2: "To close, retrieve a bottom-up investment model with WACC, year-1 to year-5 revenue ramp by SKU mix, and capex schedule for tooling and certification."
- SH2.2: "To close, run a teardown comparison of ABB MNS PDU vs Vertiv Geist vs Schneider NetShelter on remote-monitoring depth, outlet-level switching, and 3-phase 60A support."
- SH5.2: "To close, retrieve OCP and ODCC roadmap statements on 48VDC vs 800VDC bus adoption from 2026–2028."

**File paths.**

- Modified: `agents/evaluate.ts` — extend the evaluator prompt and JSON output schema with `gapClosingAction?: string`; emit only when confidence < 0.5
- Modified: `lib/schema.ts` — `EvaluationContent` gains the field
- Modified: `components/HypothesisCard.tsx` — render a "to close this gap" callout when the field is present

**Acceptance criteria.**

- All sub-hypotheses with confidence < 0.5 carry a non-empty `gapClosingAction`
- The decision card's gap list (Change 5) is populated by aggregating these actions, deduplicated and grouped by parent hypothesis
- A user can read the decision page and walk away with a research workplan, not just a verdict

**Dependencies.** Pairs with Change 5 — the decision card's gap list pulls from these fields.

**Notes.** This is the most product-defining of the eight changes. It transforms Agent Victor from a verdict tool into an iterative research tool. Worth marketing prominently in the demo.

---

## 9. Change 7 — Mode-dependence restoration on Tier-1 templates

**Problem.** Every sub-hypothesis in the first run is tagged `modeDependence: agnostic`. Several are obviously not. SH2.2 (capability gap to Vertiv / Schneider / Eaton in 24 months) is the canonical *build-only* concern: under buy, you inherit a stack; under partner, you white-label one. Marking it agnostic hides the link from Tier-1 evidence to Tier-2 mode selection.

**Target behaviour.** The framework yaml carries explicit mode tags on sub-hypothesis templates; the binder propagates them to nodes.

**File paths.**

- Modified: `frameworks/ge-9-box-with-make-buy-ally.yaml` — add `modeDependence` to each decomposition entry. Initial assignment:

```yaml
decomposition:
  - claim: "TAM-SAM-SOM bridge clears threshold"
    modeDependence: agnostic
  - claim: "Capability gap is closeable"
    modeDependence: build-only
  - claim: "Brand permission exists in target segments"
    modeDependence: build-or-partner
  - claim: "Existing electrical channels are insufficient"
    modeDependence: agnostic
  - claim: "Acquisition or partnership opens IT channels"
    modeDependence: buy-or-partner
  - claim: "Achievable margins are credible"
    modeDependence: agnostic
  - claim: "Investment vs revenue ramp clears hurdle"
    modeDependence: mode-conditional   # capex differs sharply by mode
  - claim: "Density-band migration timeline is manageable"
    modeDependence: agnostic
  - claim: "DC distribution disruption is unlikely in window"
    modeDependence: agnostic
```

- Modified: `agents/framework-binder.ts` — populate `HypothesisContent.modeDependence` from the template (currently hardcoded to `agnostic`)

**Acceptance criteria.**

- After v3 re-run, at least 4 of the 11 sub-hypotheses carry a non-`agnostic` mode tag
- When Tier 2 activates (rolled confidence ≥ 0.6 — likely in a future run after Changes 1, 3 land), the build/buy/partner reasoning explicitly references mode-tagged Tier-1 evidence

**Dependencies.** None for the change itself. Visible payoff requires Tier 2 to actually run.

**Notes.** Lowest demo priority because Tier 2 didn't fire in the first place. But it sets up correctness for future runs and is a small change.

---

## 10. Change 8 — Threshold display: value vs target, not boolean

**Problem.** The first run shows:

```
Thresholds:
- irrHurdle: met
- timeYears: met
- minRevenue: met
- internalDevMaxYears: met
```

All four read "met". But SH4.2 (the leaf that maps to the IRR threshold) sits at 0.35 with the rationale "no evidence directly addresses NPV". The threshold is not "met"; it is "not falsified" because no one tested it.

**Target behaviour.** Each threshold renders as `<name>: target <value> / observed <value-or-status>`. Statuses include:

- `<numeric>` — a real measurement was extracted from evidence
- `not directly tested` — no evidence reached the threshold variable
- `partially tested (n / m sub-hypotheses)` — some leaves measured the variable, others did not
- `met` / `not met` — only when the value is numeric and comparable to target

**File paths.**

- Modified: `agents/decide.ts` — emit per-threshold `{target, observed, status, sourceLeafIds}` records instead of booleans
- Modified: `lib/schema.ts` — `DecisionContent.thresholds` type updated
- Modified: `components/DecisionCard.tsx` — render the records; clicking a threshold drills into its source leaves

**Acceptance criteria.**

- The first-run-equivalent ABB output shows `irrHurdle: target 15% / observed: not directly tested (see SH4.2)` rather than `met`
- A threshold is shown as `met` only when a numeric observation exists and clears the target
- The drill-down click path from a threshold row leads to the sub-hypothesis(es) that informs it

**Dependencies.** Reads naturally with Changes 1 and 6 — more thresholds get tested or get explicit gap-closing actions.

**Notes.** This change is the most likely to expose how thin the evidence base actually is — which is the right outcome. Better to show the user "we didn't test this" than to claim "met" when nothing was measured.

---

## 11. Demo prioritisation

For the next demo with Daniel, ship in this order:

1. **Change 2** (weight override fix) — silent math bug; ship first
2. **Change 4** (labels + truncation) — pure polish; the run looks unprofessional otherwise
3. **Change 8** (threshold display) — biggest single credibility lift per dev-day
4. **Change 5** (decision headline framing) — fixes the misleading "Do not pursue" headline

These four are ~1.5 days total and are all demo blockers.

If a second day is available before the demo:

5. **Change 1** (test-driven queries) — biggest leap in answer quality; one full day end-to-end including template authoring

If three days are available:

6. **Change 6** (gap-closing prescriptions) — strongest new product feature; sets up a v3 marketing point ("Agent Victor produces a research workplan, not just a verdict")

Defer to v3.5 (post-demo):

7. **Change 3** (stake-aware weighting) — substantive but invisible without explanation; better to surface in a follow-up demo
8. **Change 7** (mode dependence) — zero demo payoff until Tier 2 fires

---

## 12. Out of scope for v3

Defer to v4 with a roadmap slide:

- New frameworks beyond `ge-9-box-with-make-buy-ally`
- Live brief parser as an LLM step (still config-only)
- A senior-partner critic agent that reviews the master decision before emit
- Cross-run comparison ("what changed since the last run")
- Persistent gap-closing action workflow (turn the gap list into trackable items, possibly tied to a future re-run trigger)
- Cost / latency footer on the decision card (nice-to-have, not demo-blocking)
- Human baseline diff — run a senior PDU expert past the same case, surface the delta. The v3.5+ stretch and the strongest evaluation signal once we have it

---

## 13. Open questions

**Q1 — Stake demotion rule (product, before Change 3 starts).** One-step demotion is the proposed default. Is two-step ever right? Is the rule symmetric — does `pre-disposed-against` evidence get a step-up if it agrees with the bias direction (i.e. the source's bias would have suppressed the finding, so its presence is more meaningful)? Resolve before Change 3 implementation.

**Q2 — Three-state decision vocabulary (product, before Change 5 starts).** Three states are proposed (`pursue` / `do-not-pursue` / `insufficient-evidence`). A future case may want `pursue-with-conditions` or `defer-pending-event`. Lock the v3 vocabulary now so downstream UI does not break when it expands.

**Q3 — Query template scope (technical, before Change 1 starts).** Change 1's templates are seeded by the test variable name (`npv_at_hurdle`, `approved_vendor_status_count`, etc.). The first run used 11 distinct variables. Some are case-specific (e.g. `dc_distribution_penetration`), some are generic (e.g. `blended_gross_margin`). Decide whether templates ship per-case (`cases/<id>/query-templates.yaml`) or per-framework (`frameworks/<id>/query-templates.yaml`) or globally with override. Recommend per-framework with case overrides — matches the existing weight-override pattern.

---

*End of v3 spec. Harry to translate into epics, stories, and tasks.*