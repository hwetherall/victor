# Agent Victor — V2 Roadmap: Agentic Leaves on Managed Agents

> **Status:** Forward-looking spec. Companion to `SPEC.md` (which remains the V1 / demo source of truth). Owned by the same thread (`AV-00`). Read SPEC.md first for the mission, schema, framework registry, ABB case instantiation, and demo acceptance criteria. This document picks up where V1 ends and describes the architectural shift to agentic leaves.

---

## 0. The shift in one paragraph

V1 leaves are prompt chains: each leaf runs `web-search`, `doc-retrieval`, and `question-generator` in parallel and returns whatever they produce. V2 leaves are **agents** in the strict sense — LLMs autonomously running tools in a loop, selecting methods, building artifacts, self-critiquing, and pushing back when the framework slot doesn't fit the data. The orchestrator, tree, rollup, framework binding, drill-down UI, and Micky B. Beece (V1) all stay. **The leaf execution layer changes.** That's the entire architectural delta.

The runtime for the new leaves is **Anthropic's Managed Agents** — the productized harness that handles sandboxing, tool execution, prompt caching, compaction, multi-agent orchestration, rubric-based grading (outcomes), and webhooks. Multi-agent orchestration and outcomes both went to public beta on May 6 2026; this roadmap assumes both.

---

## 1. What V1 keeps, what V2 changes

| V1 component | V2 status | Notes |
| --- | --- | --- |
| Brief Parser | Keep | Stays as config in V1; LLM upgrade still v3+ |
| Framework Binder | Keep | Hardcoded ABB binding still ships |
| Tree Builder (Sonnet) | Keep, lightly extend | Now also writes `falsifier` and `method_hints` per leaf |
| Evidence Agent (`web` / `doc` / `question` modes) | **Replace** | Becomes one Investigator agent with tool access |
| Hypothesis Evaluator (Sonnet) | Keep | Reads enriched evidence; rubric tightens |
| Confidence Rollup (deterministic) | Keep | Math is unchanged |
| Master Decision (Opus) | Keep | Reads richer reasoning traces from leaves |
| Micky B. Beece V1 | Keep | Already shipped |
| Drill-down UI / source modals | Keep, extend | New: artifact viewer (xlsx, csv, png inline) |
| Postgres + pgvector schema | Extend | New tables: `artifacts`, `reasoning_traces` |

**Non-goal:** rebuilding the orchestrator. Vercel + Next.js + Postgres + the framework registry all stay. Managed Agents is invoked from the orchestrator the same way `gatherEvidence` is today — different runtime, same call site.

---

## 2. Architecture (V2)

```
┌──────────────────────────────────────────────────────────────────┐
│                       Next.js App (unchanged)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐     │
│  │ Case Setup  │→ │ Run Monitor │→ │ Tree (Kanban + Drill │     │
│  │             │  │             │  │ + Artifact Viewer)   │     │
│  └─────────────┘  └─────────────┘  └──────────────────────┘     │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                  ┌────────────▼─────────────┐
                  │   Run Orchestrator       │  (unchanged shape)
                  └────────────┬─────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
  ┌──────────┐          ┌──────────────┐       ┌─────────────┐
  │  Brief   │  ────►   │  Framework   │ ────► │    Tree     │
  │  Parser  │          │   Binder     │       │   Builder   │
  └──────────┘          └──────────────┘       └──────┬──────┘
                                                      │
                          ┌───────────────────────────┴──┐
                          ▼                              ▼
                ┌────────────────────────┐    ┌────────────────────┐
                │  Managed Agent session │    │ ... per leaf ...   │
                │  (Investigator, Opus)  │    │                    │
                │  ┌──────────────────┐  │    └────────────────────┘
                │  │ Skills (loaded   │  │
                │  │ on demand):      │  │
                │  │  • fin-model     │  │
                │  │  • comp-teardown │  │
                │  │  • sensitivity   │  │
                │  │  • ...           │  │
                │  └──────────────────┘  │
                │  ┌──────────────────┐  │
                │  │ Tools:           │  │
                │  │  • doc-retrieval │  │
                │  │  • code-exec     │  │
                │  │  • ask-user      │  │
                │  │  • spawn-        │  │
                │  │    Researcher ──┼──┼──┐
                │  └──────────────────┘  │  │
                │  ┌──────────────────┐  │  │     ┌─────────────────────────┐
                │  │ Outcomes rubric  │  │  └────►│  Managed Agent session  │
                │  │ (self-critique)  │  │        │  (Researcher, Sonnet)   │
                │  └──────────────────┘  │        │  ┌───────────────────┐  │
                │  Sandbox filesystem    │        │  │ Tool: Tavily      │  │
                │  → artifacts.xlsx etc. │        │  │ OODA loop with    │  │
                └───────────┬────────────┘        │  │ stopping rubric   │  │
                            │                     │  └───────────────────┘  │
                            ▼                     └────────────┬────────────┘
                  ┌────────────────────┐                       │
                  │ Webhook → ingest   │◄──────────────────────┘
                  │ findings + arts    │
                  │ → Postgres         │
                  └─────────┬──────────┘
                            ▼
                  ┌────────────────────┐
                  │ Hypothesis Evaluator│
                  │ + Rollup + Decision │
                  │ + Micky narration   │
                  └────────────────────┘
```

Two Managed Agent definitions, registered once with Anthropic by ID, instantiated per call. The Investigator is the workhorse; the Researcher is a sub-agent the Investigator (and other callers) spawn for compressed web research.

---

## 3. The two agents

### 3.1 Investigator (priority #1)

**Role.** Given a hypothesis + falsifier + threshold, pick a method, execute it, build evidence (often as an artifact), self-critique against an outcomes rubric, return a confidence score with reasoning trace. One Investigator per leaf.

**Model.** Opus (judgment work; small N of leaves; cost is fine).

**System prompt skeleton.**
```
You are an investigator on a strategy case. Your job is to test ONE
hypothesis against ONE falsifier, with a clear threshold for what
"true" means. You have skills (loaded on demand) for the methods you
might apply, and tools for retrieval, computation, and human escalation.

Your loop:
1. OBSERVE — what does the falsifier require? What evidence would
   actually move the needle? What is the threshold?
2. ORIENT — which method (skill) is most likely to produce decisive
   evidence? Name the rejected alternatives and why.
3. DECIDE — pick a method and a first action.
4. ACT — execute. Use a skill, spawn a Researcher, query a doc, run
   code, ask the user.
5. SELF-CRITIQUE — does the artifact / finding actually answer the
   falsifier? If not, what's missing? Loop.

Stop when you have a defensible answer with confidence > 0.7 OR you
have explicitly named the missing inputs that prevent that confidence
(escalate as HITL).

Return: confidence (0-1), evidence summary, reasoning trace
(observe/orient/decide/act/critique steps, with rejected alternatives),
artifact paths if any, escalations if any.
```

**Tools.**
- `retrieve_documents(query)` — pgvector retrieval over case sources
- `execute_code(code)` — Python in the sandbox (Managed Agents native)
- `spawn_researcher(question, stopping_criteria)` — multi-agent orchestration call
- `ask_user(question, type, options?)` — writes to `user_questions` table
- `read_sibling_leaf(leaf_id)` — read findings from another leaf in this run
- Skills (loaded progressively, see §4)

**Outcomes rubric (per leaf).**
```
Pass conditions:
- The artifact / finding directly addresses the falsifier
- The threshold question is answered (above/below/insufficient data)
- All quantitative claims have either a source citation or a computed lineage
- Confidence is consistent with evidence strength
- Reasoning trace names at least one rejected alternative

Fail → grader prompts the Investigator to revise.
```

**Per-leaf invocation contract.**
```ts
type InvestigatorInput = {
  hypothesis: { id: string; claim: string; templateId: string };
  falsifier: string;                    // what would prove this false?
  threshold: { metric: string; value: number | string };
  caseContext: {
    question: string;
    documentIds: string[];              // pre-ingested in pgvector
    weights: Record<string, number>;
    siblingLeafIds: string[];
  };
};

type InvestigatorOutput = {
  confidence: number;
  evidenceSummary: string;
  reasoningTrace: ReasoningStep[];
  artifacts: { path: string; type: string; version: number }[];
  escalations: { question: string; type: 'yes_no' | 'open' }[];
};
```

### 3.2 Researcher (priority #2)

**Role.** Given a research question + stopping criteria, iterate web search, read results, identify gaps, search again, return a compressed structured findings summary with citations. Lives entirely in its own context window so the Investigator's stays clean.

**Model.** Sonnet (fast iteration, lower cost, parallel-friendly).

**Single tool.** Tavily web search (V1). Add others (SerpAPI, scholarly, regulatory APIs) as separate tools later — the loop logic doesn't change.

**Why a separate agent and not a skill.** Compression. The Researcher reads 30+ pages and hands back 3 paragraphs. If the Investigator did web search inline, every search result lands in the Investigator's context and pollutes it. Separate context window = clean compression boundary.

**Reusable.** Investigator is the primary caller. Other callers in V2: Tree Builder (when scoping a new hypothesis), Brief Parser (validating stakeholder claims), Micky (fact-checking before final write-up).

**System prompt skeleton.**
```
You are a research agent. You have one tool: web search.

Your loop (OODA):
1. OBSERVE — what's been gathered, what's missing for the question.
2. ORIENT — what query would close the biggest gap.
3. DECIDE — pick query terms (short, specific, distinct from prior).
4. ACT — search. Read results. Extract.

Stop when ANY of:
(a) The question is answered with sufficient confidence and at least
    one citable source.
(b) Three consecutive searches return no new relevant information.
(c) Total search count reaches the cap (default 10).

Return a structured summary: { answer, confidence, citations[],
  searchPath[] }. Compress aggressively — the caller does not want
the full raw results.
```

**Per-call contract.**
```ts
type ResearcherInput = {
  question: string;
  stoppingCriteria?: {
    confidenceTarget?: number;    // default 0.8
    maxSearches?: number;          // default 10
    diminishingReturnsThreshold?: number;  // default 3
  };
  contextHint?: string;            // case context to focus relevance
};

type ResearcherOutput = {
  answer: string;
  confidence: number;
  citations: { url: string; title: string; quote: string }[];
  searchPath: { query: string; resultCount: number; usefulCount: number }[];
  stoppedBecause: 'answered' | 'diminishing_returns' | 'cap_reached';
};
```

---

## 4. Skills as the method toolkit

The Investigator does not contain N method prompts. It contains **one OODA loop and a registry of skill descriptions.** Skills load progressively: descriptions are always in context (cheap), full instructions only load when the Investigator selects the skill.

**Format.** Standard Anthropic skill folder.
```
skills/
├── bottoms-up-financial-model/
│   ├── SKILL.md              # YAML frontmatter + instructions
│   ├── scripts/
│   │   └── build-model.py    # template generator
│   └── examples/
│       └── reference.xlsx
├── competitor-teardown/
├── sensitivity-analysis/
├── analog-case-retrieval/
├── pre-mortem-redteam/
├── patent-regulatory-timeline/
└── cohort-funnel-decomposition/
```

**SKILL.md frontmatter (description = the routing signal).**
```yaml
---
name: bottoms-up-financial-model
description: Build a bottoms-up financial model in Excel when the
  hypothesis tests an NPV / IRR / revenue threshold and qualitative
  search will not move the answer. Produces a multi-tab xlsx with
  Inputs / Scenarios / NPV bridge / Conclusion. Use the standard
  color coding (blue inputs, black formulas, green internal links,
  red external links).
---
```

**Build order for V2.**

| # | Skill | Why first |
| --- | --- | --- |
| 1 | `bottoms-up-financial-model` | Wedge demo (SH4.2). Highest visceral impact. |
| 2 | `competitor-teardown` | Hits SH2.1, SH2.2, SH3.1 — broad reuse. |
| 3 | `sensitivity-analysis` | Compounds with #1; converts point estimates to ranges. |
| 4 | `analog-case-retrieval` | Mickey-flavored: base rates from history. |
| 5 | `pre-mortem-redteam` | Generates failure modes; bridge to V3 red-team tree. |

The remaining two (`patent-regulatory-timeline`, `cohort-funnel-decomposition`) are case-dependent — build when ABB doesn't need them but a future case does.

**Every skill must produce an artifact.** That's how the drill-down stays satisfying. A skill that returns only prose is suspicious — it's probably better as a Researcher call.

---

## 5. Outcomes (rubric grading)

Anthropic's outcomes feature wraps the self-critique step. Per Investigator session, we attach a rubric (see §3.1). The grader runs after the agent thinks it's done. If the rubric fails, the Investigator gets a revision prompt with the specific failure cited. Anthropic's reported lift is up to +10pp on hard tasks; we should expect similar on the longer leaves.

**Two rubrics to author for V2:**
1. **Investigator rubric** — per §3.1.
2. **Researcher rubric** — "answer cites at least one source; stopping reason is one of the three valid options; searchPath shows query diversity (no near-duplicates)."

Outcomes is also where we get a free improvement signal. Failed-then-passed transitions are training data for tightening the system prompts.

---

## 6. The wedge demo: SH4.2

**Hypothesis:** "Investment vs revenue ramp clears IRR hurdle."

This is the leaf to make stunning before generalizing. It's a numerical threshold question; no qualitative search will answer it. The Investigator *has* to build a model. The user clicks through and sees:

1. **Micky's framing** (already-shipped V1 narration, lightly extended): "Threshold test on NPV. Qualitative search wouldn't move the needle, so I built a bottoms-up model. Rejected alternatives: comparable-transactions analog (insufficient public comps), top-down sizing (too coarse for an IRR test)."

2. **The OODA trace** (new):
   - *Observe:* IRR hurdle is 15%. Need NPV at WACC ~9%, capex + opex schedule, revenue ramp, terminal.
   - *Orient:* Pick `bottoms-up-financial-model` skill. Spawn Researcher for industry-segment margin benchmarks.
   - *Decide:* Build v1 with industry-average margins, then refine.
   - *Act:* Skill loaded. Model built. Confidence 0.55 — margins are weak input.
   - *Self-critique:* Margin assumption is doing all the work. Need ABB-specific data.
   - *Act (loop 2):* `retrieve_documents("ABB segment margins")` — finds 10-K segment data. Rebuild as v2.
   - *Critique:* Sensitivity check needed on year-3 channel ramp.
   - *Act (loop 3):* Run sensitivity. Hinges on ramp assumption. Escalate HITL.

3. **The artifact:** an actual `model.xlsx` with `Inputs` / `Scenarios` / `NPV bridge` / `Conclusion` tabs. Opens inline in the existing source modal, with a small "v2" tag.

4. **The version diff:** v1 vs v2, what input changed, why, confidence delta.

5. **The escalation:** a new question card in the HITL queue: "Year-3 channel ramp — bear case (40% of plan), base (75%), or bull (95%)?"

If this leaf works end-to-end, every other leaf is the same Investigator with a different falsifier and a different skill selection. **This is the unlock.**

---

## 7. Phased plan

| Phase | Days (rough) | Output |
| --- | --- | --- |
| P1 — Spike & wire | 1–2 | Provision Managed Agents. Investigator skeleton runs one leaf end-to-end against the existing schema. Webhook ingestion to Postgres works. No skills yet. |
| P2 — First skill (wedge) | 3–4 | `bottoms-up-financial-model` skill authored, tested standalone, then invoked by Investigator on SH4.2. Artifact lands in viewer. |
| P3 — Researcher | 5–6 | Researcher agent defined. Investigator spawns it on at least 2 leaves (SH1.2 growth trajectory, SH3.1 channel insufficiency). Stopping rubric tested. |
| P4 — Skills 2–5 | 7–10 | `competitor-teardown`, `sensitivity-analysis`, `analog-case-retrieval`, `pre-mortem-redteam`. Each tested on its highest-fit leaf. |
| P5 — Outcomes rubrics | 11 | Investigator and Researcher rubrics authored, grading on. Measure pass rate vs ungraded baseline on a 10-leaf eval set. |
| P6 — Schema + UI | 12–13 | `artifacts` and `reasoning_traces` tables. Drill-down extended: artifact viewer, OODA timeline view per leaf, version diff. |
| P7 — Micky V2 | 14–15 | Micky reads reasoning traces (not just final findings) and narrates the OODA-level "why this method." Existing V1 narration over the tree stays as the outer layer. |
| P8 — Polish + eval | 16–17 | Re-run ABB case end-to-end. Compare V2 confidences to V1 baseline. Surface any regressions. |
| P9 — Daniel demo (V2) | 18 | Same drill-down click path as V1 demo, but every leaf has an artifact and an OODA trace. |

Cut order if behind: (1) Micky V2 (V1 narration is fine), (2) Skills 4–5, (3) sensitivity skill. Cannot drop: Investigator + at least one skill + Researcher + artifact viewer. That's the demo.

---

## 8. Schema additions

```sql
-- Artifacts produced by Investigator skills
create table artifacts (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  evidence_node_id uuid references tree_nodes(id) on delete cascade,
  type text not null check (type in ('xlsx','csv','png','md','json','model_lineage')),
  uri text not null,                    -- storage path
  version integer not null default 1,
  parent_artifact_id uuid references artifacts(id),  -- v1 → v2 → v3 lineage
  metadata jsonb,                       -- skill name, inputs used, etc.
  created_at timestamptz default now()
);

create index on artifacts(evidence_node_id);
create index on artifacts(parent_artifact_id);

-- OODA reasoning traces from agents
create table reasoning_traces (
  id uuid primary key default gen_random_uuid(),
  node_id uuid not null references tree_nodes(id) on delete cascade,
  agent_type text not null check (agent_type in ('investigator','researcher','micky')),
  managed_agent_session_id text,        -- Anthropic session ID, for replay
  steps jsonb not null,                 -- array of {phase, content, timestamp, skill_used?}
  rejected_alternatives jsonb,          -- explicit list of methods/queries considered and skipped
  outcomes_grades jsonb,                -- pass/fail history if rubric was applied
  created_at timestamptz default now()
);

create index on reasoning_traces(node_id);
```

---

## 9. Explicitly deferred (V3+)

These all sit on top of Investigator infrastructure. Worth naming so we're not tempted to scope-creep them in.

- **Adversarial red team tree.** A sibling tree whose job is to kill the recommendation. Spawns its own Investigators with hostile prompts. V3.
- **Multi-framework triangulation.** Run the same question through GE 9-box, Porter, JTBD, Real Options. Divergence is the insight. V3.
- **Monte Carlo over the whole tree.** Treat every confidence as a distribution; run rollup 10,000 times; surface what the answer is sensitive to. V3.
- **Expert panel simulation.** 6–8 personas (skeptical PE partner, hyperscaler procurement, hostile competitor CEO, regulator) each evaluate the recommendation. V3.
- **Implementation pre-mortem at the decision level.** Top 20 things that kill execution, ranked, with mitigations. V3.
- **Mode-conditional re-runs.** Run the full tree once each for build / buy / partner. V3.
- **Dreaming** (Anthropic's cross-session memory consolidation). In research preview as of May 6 2026. Watch but don't plan around it.
- **Self-hosted harness fallback.** If lock-in becomes an issue. Not before it does.

---

## 10. Risks & open questions

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Managed Agents beta header (`managed-agents-2026-04-01`) behaviors shift | Medium | Pin version in env. Monitor Anthropic changelog weekly. Budget 2 reconcile passes over the next 6 months. |
| Lock-in to Anthropic harness | Low (acceptable today) | Skills format is open standard (portable). Loop logic in our orchestrator is portable. Only the harness binding is Anthropic-specific. |
| Investigator over-runs token budget on hard leaves | Medium | Outcomes rubric forces early termination on "I can't answer this" → escalates HITL instead of looping forever. Per-session token cap. |
| Researcher search loops without converging | Medium | Three stopping criteria (answered / diminishing returns / cap). Cap defaults to 10. Escalate "no answer" cleanly. |
| Skill descriptions are bad → wrong skill selected | High initially | Eval set of 20 leaf scenarios. Iterate descriptions until selection accuracy > 0.85. (See "Writing tools for agents" guidance in §11.) |
| Artifact viewer becomes the demo bottleneck | Medium | Pre-render to inline HTML / image where possible. xlsx → SheetJS in the browser. |
| Cost spike from multi-agent orchestration | Medium | Anthropic notes ~15× tokens vs single chat. Acceptable for our N (~30 leaves) and the value of the output. Track per-run cost in the runs table. |

**Open questions to resolve early in P1:**
- Confirm Managed Agents sandbox can mount our pgvector-retrieved doc chunks (or do we pass them inline?)
- Confirm webhook delivery semantics (at-least-once? ordering?) before designing the ingestion handler
- Decide: artifacts stored in Anthropic's session filesystem and copied on completion, or written directly to our storage via tool? Latter is cleaner; former is simpler.
- Confirm Outcomes grader can reference external context (the framework slot) or only the agent's own output

---

## 11. Reading list (do these tomorrow morning, in order)

**Required.**

1. [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents) — Schluntz & Zhang. The canonical patterns piece. Read the workflow patterns (routing, parallelization, orchestrator-workers, evaluator-optimizer). Our Investigator + Researcher is orchestrator-workers; outcomes is evaluator-optimizer.
2. [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview) — official docs. Skim the whole thing; the Sessions and Environments sections are where most of the V2 wiring lives.
3. [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) — the skills mental model and progressive disclosure. Internalize the SKILL.md format and the description-as-routing-signal idea.

**Strongly recommended.**

4. [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) — the reference architecture for what we're building. The OODA loop paragraph in there is verbatim what goes into the Researcher's system prompt.
5. [Scaling Managed Agents: Decoupling the brain from the hands](https://www.anthropic.com/engineering/managed-agents) — *why* Managed Agents exists as an abstraction. This is the philosophical case for not building our own harness.
6. [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) — for when we author skill descriptions and tool definitions. Affects skill-selection accuracy directly.

**Reference.**

7. [anthropics/skills GitHub repo](https://github.com/anthropics/skills) — read the `xlsx`, `pdf`, and `skill-creator` SKILL.md files. The `xlsx` one in particular is the template for our `bottoms-up-financial-model` skill.

**Skip for now (but bookmark):** dreaming research preview, the LangChain Deep Agents comparison, framework-comparison articles. None of them change a decision we're making this week.

---

## 12. Non-negotiables (V2)

Carried over and extended from SPEC.md §15. Threads cannot trade these away.

1. **Investigator is one agent class, not N.** Method specialization lives in skills, not agent definitions.
2. **Every leaf produces a reasoning trace.** No black-box leaves. The trace is the auditability story.
3. **Every method-driven leaf produces an artifact.** Prose-only outputs are a smell.
4. **Researcher's stopping criteria are explicit.** No open-ended search loops in production.
5. **Outcomes rubrics are mandatory.** Every agent definition ships with one.
6. **Drill-down click path still works.** Decision → Hypothesis → Sub-hyp → Evidence → (Source OR Artifact OR Reasoning Trace). Any V2 work that breaks this loses.
7. **V1 stays runnable.** Feature flag the leaf runtime. If Managed Agents is down, fall back to the V1 prompt-chain leaves and ship a slightly weaker demo rather than no demo.

---

*End of SPEC-V2.md. Lives alongside SPEC.md. Open to revision via the AV-00 thread only.*