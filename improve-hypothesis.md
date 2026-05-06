# AV-10: Hypothesis Quality Hardening — Lint, SCOPE, Rewrites

## Goal

Add a deterministic lint check that enforces AV-09's MBB rubric, fix the `[SCOPE]` substitution so it stops dumping a sentence into prose, and hand-rewrite the seven sub-grade claims so the next smoke run averages ≥3.7 against the rubric with zero rows ≤2.5.

## Background

AV-09 established the schema. AV-10 enforces it. The first smoke run after AV-09 produced a tree where:

- 3 of 16 claims contained predicates explicitly banned in AV-09 AC #6 ("favours," "closeable," "manageable")
- The `[SCOPE]` substitution dumped 11 words into 3 separate claims, making the prose unreadable
- 7 of 16 claims scored ≤2.5 against the rubric on manual re-grade

Root causes:

1. AV-09 AC #6 was a manual grep. Nothing automated actually ran it, so the regression slipped through.
2. The `[SCOPE]` substitution was authored as a sentence-length value but interpolated inline in three claim strings, dominating each one.
3. Several claims were ported semi-verbatim from the original ABB tree without absorbing the schema's intent — the soft predicates survived because the schema can't reject English-language vagueness.

This thread fixes all three: a lint script that makes regressions impossible to commit silently, a substitution restructure that constrains prose length at the source, and explicit drop-in rewrites for the seven flagged claims. No schema changes.

## Inputs (already in repo)

- `AV-09-mbb-hypothesis-schema.md` — the rubric this lint enforces
- `lib/schema.ts` — `HypothesisContent`, `HypothesisTest`, `ModeDependence` (do not modify)
- `lib/framework-registry.ts` — `applySubstitutions`, `applySubstitutionsDeep`, `loadFramework`, `loadCase`
- `frameworks/ge-9-box-with-make-buy-ally.yaml` — sub-hypothesis claims that need rewrites
- `cases/abb-rack-pdu.yaml` — substitutions including the long `[SCOPE]` string
- `agents/tree-builder.ts` — current `ABB_HYPOTHESES` array (read-only here; tree shape unchanged)
- `scripts/smoke-pipeline.ts` — existing smoke entry point (lint hooks in here)
- `package.json` — script registry

## Outputs

### 1. `scripts/lint-hypotheses.ts` — new lint script

A standalone TypeScript script that runs without DB or LLM calls. Behaviour:

- Accepts an optional `--case <id>` argument; defaults to `abb-rack-pdu`
- Loads the case YAML, looks up the referenced framework YAML, applies substitutions to produce the final `claim`, `falsifier`, `test.metric`, `test.target`, `test.horizon`, and `insightAtStake` for every Tier 1 slot and every sub-slot
- Runs the following checks per slot:

  **a. Banned predicates** — case-insensitive regex against `claim` and `falsifier`:
  ```
  \b(favours?|favourable|favorable|closeable|manageable|achievable)\b
  ```
  Plus `\bcredible\b` UNLESS preceded within the same string by `path to` (allows H1's "credible path to $100M…").

  **b. Word count** — `claim` ≤ 25 words; `falsifier` ≤ 35 words. Whitespace-split.

  **c. Required fields non-empty** — every slot and sub-slot has non-empty `claim`, `falsifier`, `test.metric`, `test.target` (string or number, not null/empty), `modeDependence` (must be `agnostic` or `requires_mode`), `insightAtStake`.

  **d. No leftover placeholders** — no `\[[A-Z_]+\]` substring in any post-substitution string.

  **e. Mode-dependence sanity** — emit a *warning* (not failure) when more than 2 of 5 Tier 1 hypotheses are `requires_mode`. Tier 1 should mostly be mode-agnostic; >40% being mode-dependent suggests the WHETHER/HOW separation is leaking.

- Exit 0 with green summary on pass; exit 1 with per-violation report on fail. Output format:
  ```
  cases/abb-rack-pdu.yaml: tech-resilient.density-migration: claim: banned predicate "manageable" in "100-200 kW density band migration timeline is manageable with current roadmap"
  ```

- Add to `package.json`:
  ```json
  "lint:hypotheses": "tsx scripts/lint-hypotheses.ts"
  ```

- Wire into `scripts/smoke-pipeline.ts` as the first step *before any DB or LLM call*: import the lint as a function (refactor the script to expose a `lintCase(caseId): { ok: boolean; violations: Violation[] }`), call it, exit 1 if not ok.

### 2. `cases/abb-rack-pdu.yaml` — SCOPE substitution restructure

Replace the existing `substitutions` block with:

```yaml
substitutions:
  COMPANY: ABB
  PRODUCT: rack PDU (intelligent/managed segment)
  SCOPE: global DC market (ex-restricted geos)
  SCOPE_LONG: global data center market, accessible geographies excluding restricted markets
  THRESHOLD_LOWER: $50M annual revenue
  THRESHOLD_UPPER: $100M annual revenue
  HORIZON: 3 years
  PARITY_BENCHMARKS: Vertiv, Schneider Electric, Eaton
```

The framework YAML uses `[SCOPE]` everywhere a hypothesis claim references the market. `[SCOPE_LONG]` remains available for places where the full description is needed (e.g., the case's human-facing `question` text), but **must not appear in any hypothesis claim or falsifier**. Lint check (b) word count will catch accidental misuse.

The `thresholds:` block is unchanged.

### 3. `frameworks/ge-9-box-with-make-buy-ally.yaml` — seven rewrites

Each rewrite is a complete drop-in. Preserve surrounding YAML structure (parent slot id, weight, decomposition array position); replace only the listed fields.

#### 3a. H5 (Tier 1 hypothesis: `tech-resilient`)

```yaml
- id: tech-resilient
  weight: 0.25
  claim: "ABB's payback window remains positive across both density-migration and DC-distribution disruption scenarios within [HORIZON]"
  falsifier: "Either density migration or DC distribution moves fast enough to obsolete the AC intelligent PDU before payback completes"
  test:
    type: scenario
    metric: payback_positive_under_disruption
    target: "both scenarios pass"
    horizon: "[HORIZON]"
  modeDependence: agnostic
  insightAtStake: "If false, technology risk dominates and payback never lands regardless of execution"
  decomposition: [...]  # SH5.1 and SH5.2 (5.1 rewritten below; 5.2 unchanged)
```

#### 3b. SH1.2 (`market-growth`, child of `market-attractive`)

```yaml
- id: market-growth
  claim: "Accessible market grows at ≥10% CAGR such that ABB at constant 5% share reaches [THRESHOLD_UPPER] by [HORIZON]"
  falsifier: "Forecasts show <8% CAGR, or new-entrant share >5% is implausible against incumbent retention rates"
  test:
    type: threshold
    metric: market_cagr_pct
    target: 10
    horizon: "[HORIZON]"
  modeDependence: agnostic
  insightAtStake: "If false, the path-to-[THRESHOLD_UPPER] is closed and opportunity caps below strategic threshold"
```

#### 3c. SH1.3 (`intelligent-mix`, child of `market-attractive`)

```yaml
- id: intelligent-mix
  claim: "Intelligent/managed PDUs command ≥30% price premium over basic PDUs in [SCOPE]"
  falsifier: "Pricing data shows premium <20%, or intelligent share of unit volume <40%"
  test:
    type: threshold
    metric: intelligent_price_premium_pct
    target: 30
  modeDependence: agnostic
  insightAtStake: "If false, ABB cannot differentiate on intelligence and is forced into commodity competition"
```

#### 3d. SH2.1 (`capability-gap`, child of `can-access`)

```yaml
- id: capability-gap
  claim: "ABB reaches price-performance parity with [PARITY_BENCHMARKS] within 24 months across hardware, certification, and software"
  falsifier: "Any one of (a) UL/CE certification path, (b) DCIM software stack, or (c) hardware unit cost cannot match incumbents within 24 months under any mode"
  test:
    type: threshold
    metric: months_to_parity_product
    target: 24
    horizon: months
  modeDependence: agnostic
  insightAtStake: "If false, ABB enters with an inferior product and loses bake-offs regardless of channel access"
```

#### 3e. SH2.2 (renamed `brand-permission` → `brand-permission-it`, child of `can-access`)

The electrical-room half is dropped — it's presumed granted and not the binding constraint. The IT-rack half is the actual question. ID rename makes the focus explicit.

```yaml
- id: brand-permission-it
  claim: "ABB is recognised by IT-rack procurement decision-makers at ≥3 of the top 10 hyperscalers/colos"
  falsifier: "ABB does not appear in top-of-mind PDU vendor lists in independent IT-procurement surveys, or named buyers reject ABB on brand-fit grounds"
  test:
    type: threshold
    metric: hyperscaler_brand_recognition_count
    target: 3
    horizon: at entry
  modeDependence: requires_mode
  insightAtStake: "If false, build mode dies; only buy/partner can supply IT-channel brand permission"
```

If `agents/tree-builder.ts` references the old `brand-permission` slot id, update the reference there too.

#### 3f. SH4.2 (`ramp-breakeven`, child of `financials-clear`)

This is the *marginal* claim over H4. H4 tests IRR-clears-hurdle; SH4.2 specifically tests time-to-breakeven, which is independent and binding.

```yaml
- id: ramp-breakeven
  claim: "Cash-flow breakeven achieved within 4 years of entry under at least one mode"
  falsifier: "All three modes (build/buy/partner) project breakeven >5 years given the [THRESHOLD_LOWER]–[THRESHOLD_UPPER] revenue ramp and required capital outlay"
  test:
    type: threshold
    metric: years_to_cashflow_breakeven
    target: 4
    horizon: years from entry
  modeDependence: requires_mode
  insightAtStake: "If false, cash drag during ramp consumes capital faster than the IRR justifies — unit economics blocked even if H4 IRR computes positively"
```

If the existing slot id was `investment-ramp` or similar, rename to `ramp-breakeven`.

#### 3g. SH5.1 (`density-migration`, child of `tech-resilient`)

```yaml
- id: density-migration
  claim: "ABB ships 100-200 kW rack-density PDU within 18 months of incumbent first-ship"
  falsifier: "Incumbents ship 100kW+ rack PDU and ABB has no engineering path to ship within 18 months across any mode"
  test:
    type: threshold
    metric: months_behind_incumbent_density_ship
    target: 18
    horizon: months
  modeDependence: agnostic
  insightAtStake: "If false, ABB enters with last-generation density and loses share rapidly as the market migrates"
```

### 4. Re-verify the unchanged claims

The 9 claims that scored ≥3 in the previous grading should pass the lint as-is. The most likely failure is **SH4.1** ("25-30% gross margins are achievable on intelligent PDU portfolio") — `achievable` is on the banned list. Apply the same pattern:

```yaml
- id: margins-credible
  claim: "ABB intelligent PDU portfolio sustains 25-30% gross margin after channel margin leakage and intelligent/basic mix dilution"
  falsifier: "Comparable-product margin data from incumbents shows post-channel realised margin <20%, or intelligent mix dilutes blended margin below 22%"
  test:
    type: threshold
    metric: realised_gross_margin_pct
    target: 25
    horizon: at scale
  modeDependence: agnostic
  insightAtStake: "If false, the IRR math collapses regardless of revenue ramp"
```

### 5. Optional: render new fields in the drill-down UI

If time permits, surface `falsifier` and `insightAtStake` in `components/HypothesisDrilldown.tsx` and `components/EvidenceList.tsx`. Each hypothesis card gets two collapsible rows: "Falsifier" (orange tint) and "What flips" (insightAtStake, blue tint). Reinforces the auditable-tree demo story. Skip if AC is at risk.

## Acceptance Criteria

1. `npm run lint:hypotheses` exits 0 against the updated `cases/abb-rack-pdu.yaml` and framework YAML.
2. Manually breaking any one rewrite (e.g., reverting SH2.1 to "closeable") makes `npm run lint:hypotheses` exit 1 with a violation message naming the slot id, field, and offending text.
3. `scripts/smoke-pipeline.ts` runs the lint as its first step and exits 1 with no LLM calls if lint fails.
4. `grep -E '\b(favours?|favourable|favorable|closeable|manageable|achievable)\b' cases/abb-rack-pdu.yaml frameworks/*.yaml` returns zero hits in claim/falsifier text.
5. `grep "global data center market, accessible geographies excluding restricted markets" frameworks/*.yaml` returns zero hits — no inline use of the long SCOPE string in any framework slot.
6. After a fresh smoke run, every hypothesis and sub-hypothesis row in `tree_nodes.content` has all five required fields populated (claim, falsifier, test, modeDependence, insightAtStake) and no leftover `[BRACKETED]` placeholders.
7. Manual re-grade against the AV-09 rubric: zero rows ≤2.5; average ≥3.7.
8. The seven rewritten claims (H5, SH1.2, SH1.3, SH2.1, SH2.2 renamed, SH4.2 renamed, SH5.1) appear verbatim from this spec in the framework YAML — Claude Code did not paraphrase them.
9. Tree-builder still produces 1 + 5 + 11 = 17 nodes after the rewrites. SH2.2 is reframed in place, not split.

## Out of Scope

- Any change to `lib/schema.ts`. The `HypothesisContent` shape is fixed.
- Splitting any hypothesis or sub-hypothesis into multiple new nodes. Tree shape stays at 17.
- Adding banned-word entries beyond the listed seven. New soft adjectives can be added in v2 if they surface.
- Adding a `scope` field to `HypothesisContent`. Considered and rejected — substitution shortening achieves the same prose-quality outcome with zero schema surface area.
- Lint coverage of evidence text or decision text. Hypotheses only.
- Pre-commit hook or CI integration. The lint exists as `npm run` and as the smoke-pipeline first step; ops integration is a future thread.
- Changes to the evaluator prompt. AV-09 covered it; not reopened here.
- Changes to rollup math. Test fields still aren't wired into rollup; that's a future thread.

## Open Questions

Resolve before kickoff:

1. **SH2.2 narrowing.** Dropping the electrical-room half of brand-permission is deliberate — the rationale is that electrical-room permission is presumed granted and isn't the binding constraint. Confirm; if push-back, the alternative is adding a new SH2.3 (12-node tree, breaking AC #9).
2. **Lint as smoke blocker vs warning.** Default in this spec is hard-fail before any LLM call. If you'd rather the lint print warnings but let the run proceed (useful during YAML iteration), flip it before kickoff.
3. **`credible` allowlist scope.** The lint allows "credible path to" specifically (matches H1). If "credible roadmap" or "credible plan" should also pass, expand the allowlist regex now to avoid a second lint pass later.
4. **CAGR target in SH1.2.** Picked 10% based on the ABB deck's reference to OMDIA's 10.4%. If the case team has a different number from a more authoritative source, swap the `target` before kickoff.
5. **`requires_mode` warning threshold.** Lint check (e) warns when >2 of 5 Tier 1 hypotheses are `requires_mode`. After these rewrites, H3 + H4 are mode-dependent (and SH2.2/SH4.2 at the sub level). That's exactly at the threshold — confirm 2 is the right ceiling or raise to 3.

## Suggested Order of Operations

For Claude Code's own sequencing (not part of AC):

1. Write `scripts/lint-hypotheses.ts`. Run it against the *current* YAML; expect ~6 violations from existing soft predicates and SCOPE dumps. This proves the lint catches the regressions.
2. Update `cases/abb-rack-pdu.yaml` substitutions (SCOPE shortening + SCOPE_LONG addition).
3. Apply the seven rewrites in `frameworks/ge-9-box-with-make-buy-ally.yaml`.
4. Apply the SH4.1 rewrite.
5. Re-run the lint; expect 0 violations.
6. Update `agents/tree-builder.ts` if any slot id renames need following (`brand-permission` → `brand-permission-it`, `investment-ramp` → `ramp-breakeven`).
7. Wire lint into `scripts/smoke-pipeline.ts` as step 0.
8. Run `npx tsx scripts/smoke-pipeline.ts` end-to-end; verify 17-node tree with all required fields populated.
9. (Optional) UI render of falsifier + insightAtStake.