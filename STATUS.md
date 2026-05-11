# Agent Victor — Status

> Forward-looking working summary. Updated 2026-05-11 at session 4 close.
> Companion to `spec-v2-plan.md` (which tracks per-session archeology) and
> `spec-v2.md` (architecture source of truth).

## Where we are

**The V2 wedge demo works end-to-end.** A real Sonnet 4.6 Investigator session for SH4.2 ("Investment vs revenue ramp clears 15% IRR hurdle") produces:

- A real `model.xlsx` financial model in InsForge storage, rendered inline via SheetJS in the drill-down (4 tabs: Inputs / Scenarios / NPV bridge / Conclusion)
- A 60-step OODA reasoning trace with substantive bash + retrieve_documents + ask_user activity
- A HITL escalation card visible in the questions panel
- Confidence + status surfaced on the SH4.2 kanban card

Cost: **$0.13 per wedge run** on Sonnet. Demo day is ~2 weeks out (target 2026-05-25). Wedge demo is in the bank.

Harry verified the click path in the browser at session 4 close.

## What we're struggling with

Three real issues, ranked by how much they matter for demo day.

### 1. Excel quality is "light on" (HIGH — Harry's headline feedback)

The agent's xlsx is mechanically valid (real formulas, four-tab structure, calculated NPV/IRR/payback) but the *content* isn't believable. Placeholder inputs, no ABB-specific anchoring from the 10-K or pitch deck, no Sources tab, sparse Conclusion-tab prose. Acceptable for a demo against a basic case; embarrassing once Daniel reads it.

**Root cause.** The bottoms-up-financial-model skill (`skills/bottoms-up-financial-model/scripts/build-model.py`) is a generic template. The agent has to invent inputs and reasoning text on the fly. With no scaffolding for *which* inputs to anchor to which sources, it defaults to plausible-looking but generic numbers.

**Fix shape.** Enrich the skill scaffolding, not the agent. Specifically:
- Pre-populated input defaults sourced from the ABB 10-K + deck (margin band, segment growth, capex breakdown)
- Sources tab automatically generated, linking each input to its `source_id` from `retrieve_documents`
- Sensitivity tab built INTO the skill template (not requiring the agent to add it as a follow-up)
- Conclusion-tab prose pre-shaped — agent fills in the verdict, not the structure
- Header formatting, frozen panes, color coding per the original spec (blue inputs, black formulas, green/red linked cells)

### 2. Agent doesn't emit structured CONFIDENCE blocks (MEDIUM)

The AGENT.md and tool descriptions explicitly require a final `agent.message` starting with `CONFIDENCE: <0-1>` plus `EVIDENCE_SUMMARY:` / `ARTIFACTS:` / `ESCALATIONS:` / `REJECTED_ALTERNATIVES:` keys. The agent ignores this consistently across Haiku 4.5 and Sonnet 4.6, ending with chatty prose like "The model looks correct. Now upload the artifact immediately." instead. We fall back to:

- `confidence = 0.55` from the "produced an artifact" fallback (defensible but generic)
- `evidence_summary` = the chatty message tail (mediocre demo copy)
- `rejected_alternatives = []` (no auditability of "we considered X but chose Y")

This also means the outcomes rubric grader never fires (`outcomes_grades: []`), so we have no calibration signal for STORY-020 Phase B. The grader can't enforce what the agent doesn't emit.

**Possible fixes** — in increasing order of invasiveness:
- Try inverting the AGENT.md structure: put the output format spec FIRST (the model reads top-to-bottom; format-first registers harder, per session 3's gotcha #14)
- Add a synthetic `user.message` after rescue completes: "Now emit the CONFIDENCE block as your final message." Costs another turn (~$0.05–0.20 per leaf).
- Surface the model's Conclusion-tab content in the drill-down UI instead of the agent's chatty tail. Bypasses the issue at display time.

### 3. Reproducibility unknown (MEDIUM)

We have exactly ONE successful end-to-end wedge run. We don't yet know if the rescue lands the artifact every time, or whether substantive OODA traces happen reliably, or whether some runs go 10 steps and others 60. The wedge demo's robustness on demo day depends on this.

**Fix.** Re-fire `/api/dev/integration-sh42` 2–3 times on the same agent, inspect each run's step count, artifact_id, trace length. ~$0.50 total. Lowest-cost de-risk move available.

## What we're doing next

In priority order. Each is independent — can be reordered if anything urgent surfaces.

| # | Move | Time | Cost | Why first / why later |
|---|---|---|---|---|
| 1 | **Reproducibility check.** Re-fire wedge 2–3 times on current Sonnet agent. | 1–2 hours | ~$0.50 | Cheapest de-risk. If reproducibility is good, builds confidence in the wedge baseline. If any run fails, we catch it now rather than during demo prep. |
| 2 | **Skill quality work.** Enrich `skills/bottoms-up-financial-model/scripts/build-model.py` per the "fix shape" list under issue #1. ABB-anchored defaults, Sources tab, prebuilt Sensitivity, richer Conclusion. | 4–6 hours | ~$1 | Biggest demo-quality lever currently available. Harry's headline feedback. Skill scaffolding is the right level — does the work for the agent rather than asking the agent to do it. |
| 3 | **STORY-022 — full 11-leaf ABB V2 run.** Run the entire case with `LEAF_RUNTIME=v2`. Most leaves won't have a skill-driven artifact (skills #2–5 not authored yet) but every leaf produces an OODA trace, artifact-shaped leaves get the rescue, and the rollup + hypothesis evaluator + decision node exercise the V2 surface. | 4 hours | ~$5–15 | Full case dry-run. After this, STORY-023 (pre-bake) pins the result as the demo run. Big spend, big confidence. |
| 4 | **STORY-023 — pre-bake demo run.** Mark a known-good run with `is_demo=true`. Insurance against Anthropic outages on demo day. | 1 hour | $0 (uses the run from #3) | Demo insurance. |
| 5 | **STORY-029 — demo script + rehearsal.** Written 10-step click path, narrative line per step. | 2 hours | $0 | Handoff artifact. Written by the developer who built the system, not as an afterthought. |

## What we're deferring

Per session 1's cut order, in cut-first order:

- **EPIC-010 Micky V2** (narrate the OODA trace) — V1 narration is enough for the demo
- **STORY-014 / STORY-015** — skills #4 (analog case retrieval) and #5 (pre-mortem redteam)
- **STORY-013** — skill #3 (sensitivity-analysis), if the bottoms-up skill picks it up internally
- **STORY-020 rubric calibration** — moot until the agent emits parseable CONFIDENCE blocks (issue #2 above)

## Known infra workarounds (worth naming)

These are stable but not "the right answer" long-term. Documented here so they're not invisible:

1. **Server-side artifact rescue** (`lib/managed-agents-client.ts` + `lib/investigator-tools.ts`). The agent runs `base64 -w 0 file.xlsx` in bash and stops; our orchestrator picks up the b64 from the tool_result, uploads via the existing handler, tags `metadata.rescued_from_bash=true`. Replace when Anthropic exposes a sandbox file-read API or Claude gets better at chaining the bash→upload step.
2. **Non-multiagent Investigator agent.** Anthropic's multiagent dispatch broke 2026-05-08 and the only verified fix was registering the Investigator without the Researcher in its roster. Loses Investigator→Researcher delegation on research-shaped leaves. Re-check whether multiagent works each new session.
3. **`/api/dev/rewire-wedge` route.** `integration-sh42` creates a `parent_id: null` orphan node for dispatch isolation; this route moves its outputs onto the canonical V1 SH4.2 leaf so the drill-down UI renders them. Manual ergonomics. Worth refactoring eventually so the orchestrator dispatches against the V1 tree directly.

## Live state

- **Demo data:** SH4.2 node `447a9267-7693-47f3-a17d-3dd3d0c6f7dd` in case `bec2d02b-…` is wired with the V2 artifact + trace + HITL question.
- **Current Investigator agent:** `agent_01Byab6UgSEh3bWeyMxf6smp` (Sonnet 4.6, non-multiagent, sharpened upload prompt 7032 chars, bottoms-up skill attached).
- **Working dev URL:** `http://localhost:3000/case/abb-rack-pdu` → drill into "Unit Economics" → SH4.2.
- **Artifact storage:** InsForge public `artifacts` bucket, path `bec2d02b-…/b85b1f41-…/v1_model.xlsx`.
- **Cost spent in V2 to date:** roughly $15–18 across sessions 1–4 (well under the $30–270 STORY-022 budget alone).

## Reading this file in the future

If you're picking this up after a gap and want to know what to do:

1. Skim "Where we are" (1 paragraph)
2. Skim "What we're struggling with" — does any of it still apply?
3. Look at "What we're doing next" — top row is the cheapest, top-of-mind move
4. Consult `spec-v2-plan.md` Session 4 status for the technical detail
