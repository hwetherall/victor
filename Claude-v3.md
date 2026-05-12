# Claude V3 — Three Hero Leaves Spec

> Working document for V3 demo scope. Companion to `spec-v2.md` (architecture) and `STATUS.md` (running state).
> Created 2026-05-11. Demo target 2026-05-25.

## Context

V2 landed one working wedge leaf (SH4.2, investment-vs-ramp). Mechanically end-to-end but light on quality, and the system reads as one-trick at this scope. V3 widens to **three hero leaves chosen to demonstrate architectural range**, not to expand coverage of the case for its own sake.

This is not "scale the wedge to 11 leaves." That dilutes attention and prep time. V3 is "pick three leaves that *each* demonstrate a different shape of managed-agents-plus-skills work, rehearse them tight, and let the architectural pitch land."

## Strategic frame

The demo target is Daniel. The pitch is: **Claude managed agents is the right pathway for Innovera.** The three hero leaves are designed to make that pitch architecturally, not rhetorically — by showing the *same* underlying system produce three visibly different shapes of analysis, each leaning on a capability that's hard to build without managed agents.

What managed agents make easy that you'd otherwise build from scratch:
- Multi-turn OODA loops with stateful reasoning
- Skill execution (custom tools with file outputs)
- HITL escalation with structured questions
- Document retrieval with source-grounded citations
- Structured traces with calibrated confidence

The three hero leaves are picked so that *together* they exercise all five.

## The three leaves at a glance

| Leaf | Top-level hypothesis | Shape | Hero capability | Artifact |
|---|---|---|---|---|
| 1. `investment-vs-ramp` (SH4.2) | financials-clear | Quantitative financial modeling | Skill-driven xlsx with source-anchored inputs | Multi-tab Excel model |
| 2. `capability-gap` | can-win | Competitive intelligence synthesis | Heavy retrieve_documents across 3+ competitor sources | Competitive matrix (xlsx + narrative) |
| 3. `electrical-channels-insufficient` | can-reach | Strategic judgment with explicit HITL | Dramatic escalation: agent refuses to fake an answer | Channel map + targeted expert questions |

Coverage spans 3 of 5 top-level hypotheses, which means we can also demonstrate **partial rollup** — the agent aggregating leaf conclusions into top-level hypothesis verdicts on financials-clear, can-win, can-reach — without needing all 11 leaves built.

---

## Leaf 1 — `investment-vs-ramp` (SH4.2)

**Hypothesis.** Investment vs revenue ramp clears ABB's 15% IRR hurdle.

**What this leaf demonstrates.** The agent thinks like a junior financial analyst. It builds a real financial model with believable inputs anchored to ABB-specific sources, runs sensitivity, escalates the one decision it can't make from public data (investment phasing), and produces a verdict with structured confidence.

**Current state.** Wedge demo is wired end-to-end. xlsx mechanically valid (4 tabs: Inputs / Scenarios / NPV bridge / Conclusion). HITL escalation present on questions panel. OODA trace ~60 steps. Cost ~$0.13/run. **Quality is the issue, not function.**

### Polish targets

The bottoms-up-financial-model skill is generic. Enrich the skill scaffolding so the agent fills in the verdict, not the structure:

**Pre-populated input defaults from ABB sources**
- Operating margin band: pulled from ABB 10-K segment reporting (Electrification segment specifically)
- Segment growth: ABB Electrification 3-year revenue CAGR
- Capex breakdown: ABB pitch deck + 10-K capex notes, mapped to plant build-out / R&D / channel investment
- Working capital assumptions: ABB historical WC/revenue ratio
- Each default cell flagged with the source it came from

**Sources tab (new)**
- Auto-generated from `retrieve_documents` calls during the run
- Each row: input name → cell reference in Inputs tab → source document → page/section → quoted snippet
- This is the auditability artifact — Daniel can see every number traced to a real doc

**Sensitivity tab (new)**
- Built INTO the skill template, not requested by agent as a follow-up
- IRR sensitivity to: price realization, volume ramp slope, gross margin band, year-2 vs year-3 capex split
- Tornado chart if SheetJS rendering supports it; else a labeled sensitivity grid

**Conclusion tab — pre-shaped prose**
- Template has fixed structure: Verdict / Key drivers / Risks / What would change my mind / Recommended next step
- Agent fills in the cells, doesn't invent the structure

**Visual standards**
- Blue font for inputs, black for formulas, green for linked outputs (Goldman/McKinsey convention)
- Frozen panes on each tab
- Header band with case name + run date + agent version
- Number formatting: $ for currency, % for ratios, 1 decimal for IRR

### HITL pattern

Already wired. Question to retain: investment phasing (year-1 heavy vs spread evenly). This is genuinely an ABB-internal capital allocation question — keep it, but tighten the wording per the AGENT.md format-first rewrite.

### Quality bar

The xlsx must be something Harry would send to a real VC analyst without flinching. Read test: open the Sources tab cold and trace 5 random numbers to their origin docs. If you can't, it's not done.

---

## Leaf 2 — `capability-gap`

**Hypothesis.** Gap to Vertiv, Schneider Electric, Eaton closeable within 24 months.

**What this leaf demonstrates.** The agent thinks like a strategy consultant. It pulls heavily from competitor public filings and product specs, synthesizes a structured competitive view, and rates ABB's gap with explicit time-to-close estimates. Heavy use of `retrieve_documents`, different artifact shape from SH4.2.

**Why this leaf.** Range. Three xlsx files in a row would read as "Claude only does Excel." A competitive matrix uses a different skill, exercises different agent muscles (multi-source synthesis vs. computation), and produces a visibly different artifact in the drill-down UI.

### New skill: `competitive-landscape`

Spec for the skill:

**Inputs the agent supplies**
- List of competitors (e.g., Vertiv, Schneider Electric, Eaton)
- Capability dimensions to evaluate (e.g., intelligent PDU SKU breadth, software/management layer, channel reach in IT, OEM partnerships, density ratings, certifications)
- Time horizon for gap-closing assessment (24 months)
- Source documents already retrieved

**Skill produces**
- `capability-matrix.xlsx` — rows = capabilities, columns = ABB + each competitor. Cells contain:
  - A scoring tier (e.g., Leader / Parity / Gap / Significant gap)
  - A short text justification (≤30 words)
  - A `source_id` reference linked to Sources tab
- A `Time-to-close` column at the right of the matrix with the agent's per-capability estimate (months) plus rationale
- A Sources tab in the same format as Leaf 1
- A `Summary` tab: top-line verdict, top 3 closeable gaps, top 2 hard-to-close gaps, time-to-close distribution chart

**Quality bar.** Each cell has a source. No "Leader" or "Gap" assignment without a citation. The Summary tab Verdict cell reads like something a junior analyst would write after a week of work — not generic, not waffle.

### Source corpus needs

Before committing, validate the case corpus contains:
- Vertiv 10-K (NYSE: VRT) — confirm latest fiscal year
- Schneider Electric annual report (Euronext: SU) — confirm latest
- Eaton 10-K (NYSE: ETN) — confirm latest
- ABB Electrification segment data (10-K + investor day)
- At least one industry analyst report on intelligent PDU market (451 Research, Synergy, Omdia, IDC)
- Product spec sheets for each competitor's flagship intelligent PDU line

If two or more of these are absent, swap this leaf for `margins-credible` (xlsx-shaped, would lose artifact-type diversity but is safer).

### HITL pattern

Lighter than Leaves 1 and 3. Possible escalation: "ABB's reported intelligent PDU roadmap for 2027 is not specified in public sources — recommend confirming scope and target density band with the BU lead before committing to a 24-month gap-closing verdict."

### Effort estimate

Skill build: 6-10 hours. Includes scaffolding the matrix template, Sources tab logic, and prompt engineering for the agent to use it well.

---

## Leaf 3 — `electrical-channels-insufficient`

**Hypothesis.** Existing ABB electrical channels cannot reach IT decision-makers for rack PDU.

**What this leaf demonstrates.** The agent thinks like a real analyst who knows the limits of public data. It does what it can from public sources, then *escalates sharply* with specific, narrow expert questions. The behavior — refusing to fake an answer — is the WOW.

**Why this leaf.** HITL is mentioned in V2 but not really visible at quality. This leaf makes HITL the headline behavior. Daniel sees Claude doing the right thing when it hits a knowledge wall, which is the moment the system feels trustworthy.

### Artifact shape

Two files. Both lightweight.

**`channel-map.md` (or `.html` for nicer rendering)**
- Industry-level channel structure for rack PDU sales: electrical distributors → IT VARs → hyperscaler direct procurement → colo operators → enterprise IT
- Buyer persona analysis: who specifies rack PDU at each segment (facilities vs IT vs procurement)
- ABB's likely position in each channel based on public information (segment commentary, partner announcements)
- Explicit "what we can say from public sources" / "what we cannot" division
- Each public-source claim cited

**`escalation-questions.md`**
- 4-6 specific, narrow questions the agent needs to answer the hypothesis confidently
- Each question scoped tight enough that an internal ABB stakeholder can answer in 1-2 sentences
- Example shape:
  - "What percentage of ABB Electrification revenue is from end customers who also operate data centers? Named accounts if available."
  - "Does ABB have any current OEM or reseller agreements with rack manufacturers (Rittal, nVent, Vertiv)?"
  - "Of ABB's top 50 channel partners in North America, how many carry IT infrastructure SKUs vs purely electrical?"
- Each question tagged with which sub-claim it would resolve

### HITL pattern — the centerpiece

The agent's final message should make the escalation feel *deliberate*, not failed:

> "I have moderate confidence (0.50-0.60) that the structural channel gap exists, based on industry channel norms and ABB's segment reporting. I cannot verify ABB-specific channel coverage from available public sources. To move to high confidence on this hypothesis I need expert input on the four questions in `escalation-questions.md`. With those answered, I expect to land at 0.85+ confidence in either direction."

This is the line Daniel hears in the demo narrative. **Memorize it.**

### Source corpus needs

Lighter than Leaf 2. Need:
- ABB segment reporting (already in corpus for Leaf 1)
- Industry channel structure references (could be analyst reports or specialist publications)
- One or two named hyperscaler procurement pieces (public Amazon, Google, Microsoft data center sourcing commentary)

### Quality bar

The escalation questions must be the kind that, if a real ABB BU lead read them, they'd say "yes, those are the right questions to ask me." Not generic ("tell me about your channels"), not impossible ("share your full customer database"). Specific, narrow, answerable.

### Effort estimate

3-4 hours. No new skill needed — this is mostly prompt engineering, artifact templating, and agent behavior shaping.

---

## Cross-cutting work

### CONFIDENCE block fix (still blocking all three leaves)

Per STATUS.md issue #2. Without parseable `CONFIDENCE:` / `EVIDENCE_SUMMARY:` / `ARTIFACTS:` / `ESCALATIONS:` / `REJECTED_ALTERNATIVES:` blocks, the outcomes grader doesn't fire and the auditability story collapses. All three hero leaves need this working.

Order of fixes to try:
1. **Format-first AGENT.md rewrite** (cheap, 1-2 hours). Move the output format spec to the top of AGENT.md. Test on a wedge run before committing to it across all three leaves.
2. If #1 doesn't land, add a synthetic `user.message` after rescue: "Now emit the CONFIDENCE block as your final message." Costs an extra turn but reliable.
3. As fallback only — surface the model's Conclusion-tab content in the drill-down UI instead of the agent message tail. Bypasses the issue at display time, but doesn't fix the grader signal.

Do this **before** running the three hero leaves end-to-end. Otherwise we re-fire expensive runs to get clean traces.

### Source corpus validation

Before committing to Leaf 2 and Leaf 3, check the case corpus for the named documents. Specifically:
- Vertiv, Schneider, Eaton 10-Ks present and current?
- Industry analyst report on intelligent PDU?
- Hyperscaler procurement source material?

If Leaf 2's corpus is thin, swap to `margins-credible`. If Leaf 3's is thin, that's actually fine — the *point* of Leaf 3 is that public sources are insufficient and the agent escalates.

### Rollup across top-level hypotheses

Each hero leaf sits under a different top-level hypothesis. After the three leaves run cleanly, fire the rollup for each:
- `financials-clear` → has 1 of 2 leaves done (SH4.2). Rollup says "partial evidence, leaning positive."
- `can-win` → has 1 of 2 leaves done (capability-gap). Rollup similarly partial.
- `can-reach` → has 1 of 2 leaves done (channels). Rollup partial with explicit HITL dependency.

This is a third architectural beat for the demo: the agent doing rollups, with calibrated language about what's known vs. pending. Costs almost nothing if the leaf outputs are clean.

---

## Demo flow (10-step click path)

The walkthrough Daniel sees. Each step has a narrative beat.

1. **Case home** — "This is the ABB Rack PDU case. Five top-level hypotheses, eleven sub-hypotheses."
2. **Drill into `financials-clear`** — "Let's start with the financial question."
3. **Open SH4.2 drill-down** — "Here's the agent's reasoning trace. Sixty steps. Bash, document retrieval, escalation."
4. **Open the xlsx artifact inline** — "Real financial model. Four tabs. Calculated NPV and IRR. Now the Sources tab — every input traced back to the ABB 10-K and pitch deck."
5. **Show the HITL card** — "The one thing the agent couldn't decide from public sources is here, ready for the deal team."
6. **Back up, drill into `can-win`** — "Different question, different shape."
7. **Open capability-gap drill-down** — "Same architecture, different skill. Competitive matrix against Vertiv, Schneider, Eaton. Each cell sourced."
8. **Back up, drill into `can-reach`** — "Now the interesting case."
9. **Open channels drill-down** — "Public sources can't fully answer this. Watch what the agent does." → escalation message with the four specific expert questions.
10. **Show the partial rollups** — "Three hypotheses with calibrated verdicts. The system knows what it knows."

Total run time in the demo: 8-12 minutes of click-through, plus Q&A.

---

## Effort and sequencing

| # | Move | Time | Cost | Dependency |
|---|---|---|---|---|
| 1 | Reproducibility check on SH4.2 (3 runs) | 1-2h | ~$0.50 | none |
| 2 | AGENT.md format-first rewrite + test for CONFIDENCE block | 1-2h | ~$0.25 | none |
| 3 | Source corpus validation for Leaves 2 and 3 | 1h | $0 | none |
| 4 | SH4.2 skill enrichment (Leaf 1 polish) | 4-6h | ~$1 | (2) preferred |
| 5 | `competitive-landscape` skill build (Leaf 2) | 6-10h | ~$1 | (2), (3) |
| 6 | Channels leaf prompt + artifact shaping (Leaf 3) | 3-4h | ~$0.50 | (2) |
| 7 | Three-leaf integration run | 3-4h | ~$5-10 | (4), (5), (6) |
| 8 | Rollup runs (3 top-level) | 1h | ~$1-2 | (7) |
| 9 | Pre-bake demo runs (STORY-023) | 1h | $0 | (7), (8) |
| 10 | Demo script + rehearsal (STORY-029) | 2h | $0 | (9) |
| **Total** | | **23-33h** | **~$10-15** | |

Slack budget: 15-25h over 2 weeks. Tight but feasible if nothing else surfaces.

---

## Risks and mitigations

**Risk: `competitive-landscape` skill takes longer than estimated.**
Mitigation: hard cap at 12 hours. If it's not working by then, swap Leaf 2 to `margins-credible` (existing skill, similar to SH4.2 in shape). Accept loss of artifact diversity for schedule safety.

**Risk: source corpus is thinner than assumed.**
Mitigation: validate at step 3 of the sequencing above, before sinking skill build time. If corpus is thin on competitors, swap leaf. If thin on channels, no problem — leans into the HITL story.

**Risk: CONFIDENCE block fix doesn't land.**
Mitigation: fall back to synthetic user-turn (option 2 above). Worst case, fall back to display-layer bypass (option 3). Neither is ideal but neither breaks the demo.

**Risk: Anthropic outage on demo day.**
Mitigation: STORY-023 pre-bake. Three leaves marked `is_demo=true`, served from stored artifact + trace data even if live agents fail.

**Risk: scope creep — pressure to add a fourth leaf.**
Mitigation: written rule, here, now: **no fourth leaf**. Polish beats coverage.

---

## What's still out of scope

Explicitly not in V3:
- Skill #3 (sensitivity-analysis as standalone) — folded into Leaf 1's bottoms-up skill
- Skill #4 (analog case retrieval)
- Skill #5 (pre-mortem redteam)
- EPIC-010 Micky V2 (narrate the OODA trace)
- Multiagent dispatch re-enable (re-check next session per STATUS.md but not blocking)
- The other 8 leaves of the case
- Demo of a non-ABB case

These come back into scope after the Daniel pitch lands and the architectural direction is approved.

---

## Reading this file in the future

If you're picking this up cold:
1. Skim the "three leaves at a glance" table
2. If we're pre-build: read the leaf sections in order, then "Effort and sequencing"
3. If we're mid-build: check `STATUS.md` for what's done, then the relevant leaf section here
4. If we're post-demo: this is the spec we built against; check against what actually shipped