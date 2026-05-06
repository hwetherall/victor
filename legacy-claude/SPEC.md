# Agent Victor — v1 Specification

> **Status:** Master spec for the 14-day demo build. Owned by thread `AV-00`. Every other thread reads from here and does not redefine. Changes go back through this thread first.

---

## 1. Mission

Agent Victor is an AI decision-making framework tool inspired by the MBB case-study method. It takes a strategic question plus supporting documents, selects an appropriate consulting framework, decomposes the question into a MECE hypothesis tree, gathers evidence at every leaf, rolls confidence upward via weighted aggregation, and produces a defensible decision the user can audit click-by-click down to original sources.

Named after Victor Cheng of *Case Interview Secrets* fame.

**v1 demo target:** end-to-end run on the ABB Rack PDU case for an internal demo to Daniel (Innovera CEO). The single thing that has to work flawlessly: drill-down from final decision to original source citation.

---

## 2. The 14-Day Plan

| Phase | Days | Output |
| --- | --- | --- |
| Foundation | 1–2 | Scaffolding, schema, ABB config, empty tree renders from config |
| Pipeline | 3–5 | Evidence agents, evaluators, master decision; full pipeline end-to-end |
| Polish | 6–9 | HITL question batching; Kanban + drill-down UI; source modals |
| Multi-model | 10–11 | Mistral + Gemini at evidence layer via OpenRouter or InsForge gateway |
| Demo prep | 12–13 | Pre-cached run, click-path script, error handling |
| Demo | 14 | Show Daniel |

Cut order if behind: (1) multi-model, (2) HITL wiring, (3) live-build animation. Cannot drop: drill-down click path.

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Next.js App                             │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐   │
│  │  Case Setup │→ │ Run Monitor │→ │ Tree (Kanban + Drill)│   │
│  └─────────────┘  └─────────────┘  └──────────────────────┘   │
└─────────────────────────┬───────────────────────────────────────┘
                          │
              ┌───────────▼────────────┐
              │   Run Orchestrator     │   (Edge Function or API route)
              └───────────┬────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
  ┌──────────┐     ┌──────────────┐  ┌─────────────┐
  │  Brief   │     │  Framework   │  │    Tree     │
  │  Parser  │  →  │   Binder     │→ │   Builder   │
  │ (config) │     │  (config)    │  │  (Sonnet)   │
  └──────────┘     └──────────────┘  └──────┬──────┘
                                            │
                          ┌─────────────────┼──────────────────┐
                          ▼                 ▼                  ▼
                    ┌──────────┐     ┌──────────┐      ┌──────────┐
                    │ Evidence │     │ Evidence │ ...  │ Evidence │
                    │ Agent #1 │     │ Agent #2 │      │ Agent #N │
                    │ (Mistral)│     │ (Gemini) │      │ (Sonnet) │
                    └────┬─────┘     └────┬─────┘      └────┬─────┘
                         └────────────────┼────────────────┘
                                          ▼
                              ┌────────────────────┐
                              │ Hypothesis         │
                              │ Evaluators (Sonnet)│
                              └─────────┬──────────┘
                                        ▼
                              ┌────────────────────┐
                              │ Confidence Rollup  │
                              │ (weighted, AND)    │
                              └─────────┬──────────┘
                                        ▼
                              ┌────────────────────┐
                              │ Master Decision    │
                              │      (Opus)        │
                              └────────────────────┘
                                        │
                                        ▼
                              ┌────────────────────┐
                              │  Postgres + pgvec  │
                              └────────────────────┘
```

Async execution model. The user kicks off a run, the orchestrator builds the tree, fans out evidence agents in parallel (`Promise.all`), evaluates, rolls up, and writes everything to the DB. The UI subscribes to the run status and renders progressively.

---

## 4. Tech Stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend | Next.js 15 (App Router) on Vercel | TypeScript throughout |
| Backend | InsForge first, Supabase fallback | See §4.1 |
| Database | Postgres + pgvector | Identical on both backends |
| LLM access | OpenRouter (or InsForge Model Gateway) | Wrapped behind `lib/llm-client.ts` |
| Web search | Tavily | Single provider for v1 |
| Tree viz | React Flow | Customisable, well-supported |
| Styling | Tailwind | Default Next.js setup |
| State (client) | TanStack Query + minimal Zustand | No Redux |
| Deployment | Vercel + the chosen backend | One-command deploy |

### 4.1 Backend decision rule

Day 1 morning, attempt InsForge. Acceptance gate by 1pm: provisioned DB, auth working, storage bucket created, pgvector enabled, basic write+read confirmed. If gate fails → switch to Supabase same day. The data-layer abstraction in `lib/db.ts` makes swap-cost ~3 hours.

Reasons to prefer InsForge: native MCP for Claude Code (less context shuttle), Model Gateway eliminates OpenRouter dependency, all primitives in one platform.

Reasons it might not work: ~6 months old in production, thinner ecosystem, agent-native API is novel and may have edges. Apache 2.0, self-hostable as escape hatch.

---

## 5. Data Model

### 5.1 Schema (`schema.sql`)

```sql
-- Cases: one per question being analyzed
create table cases (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  question text not null,
  framework_id text not null,        -- references frameworks/*.yaml
  weights jsonb not null,             -- {marketSize: 0.25, techResilience: 0.25, ...}
  thresholds jsonb not null,          -- {minRevenue: 100000000, timeYears: 3, ...}
  brief_extract jsonb,                -- structured output of brief parser
  created_at timestamptz default now()
);

-- Tree nodes: every node in the decision tree
create table tree_nodes (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  parent_id uuid references tree_nodes(id) on delete cascade,
  type text not null check (type in (
    'decision', 'hypothesis', 'sub_hypothesis',
    'evidence', 'question'
  )),
  label text not null,                -- short human-readable
  content jsonb not null,             -- type-specific payload, see §5.2
  confidence numeric check (confidence >= 0 and confidence <= 1),
  evidence_strength integer default 0,
  weight numeric,                     -- only set for top-level hypotheses
  scenario_id uuid,                   -- null = baseline; v2 feature
  model_used text,                    -- which LLM produced this node
  status text default 'pending'       -- pending | running | complete | failed
    check (status in ('pending','running','complete','failed')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index on tree_nodes(case_id);
create index on tree_nodes(parent_id);
create index on tree_nodes(scenario_id);

-- Sources: documents, URLs, user inputs
create table sources (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  type text not null check (type in ('web','pdf','docx','user_input')),
  uri text,                           -- URL or storage path
  title text,
  content_extract text,
  embedding vector(1536),
  metadata jsonb,                     -- author, page, stake, ingestion_date, etc.
  created_at timestamptz default now()
);

create index on sources using ivfflat (embedding vector_cosine_ops);

-- Evidence-to-source linkage (many-to-many; one piece of evidence may cite multiple sources)
create table evidence_sources (
  evidence_node_id uuid references tree_nodes(id) on delete cascade,
  source_id uuid references sources(id) on delete cascade,
  quote text,                         -- the specific extract supporting the claim
  page_number integer,                -- for PDFs
  primary key (evidence_node_id, source_id)
);

-- HITL questions: batched questions to the user
create table user_questions (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  question text not null,
  question_type text not null check (question_type in ('yes_no','yes_no_context','open')),
  options jsonb,                      -- for multi-select; null otherwise
  affects_node_ids uuid[] not null,   -- which leaves use this answer
  answer text,
  answered_at timestamptz,
  created_at timestamptz default now()
);

-- Runs: an execution of a case (baseline or scenario)
create table runs (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references cases(id) on delete cascade,
  scenario_id uuid,                   -- null = baseline
  status text not null default 'pending'
    check (status in ('pending','running','awaiting_input','complete','failed')),
  started_at timestamptz default now(),
  completed_at timestamptz,
  error text
);
```

### 5.2 `content` payload shapes by node type

```ts
// Decision node (root)
type DecisionContent = {
  finalDecision: string;            // "Pursue rack PDU via acquisition"
  reasoning: string;
  weakestLinkNodeId: string;        // id of the dragging-down hypothesis
  thresholdsMet: Record<string, boolean>;
};

// Hypothesis / sub-hypothesis
type HypothesisContent = {
  claim: string;                    // "Accessible market clears $100M/3yr threshold"
  templateId?: string;              // which framework slot this came from
  rationale?: string;               // evaluator's reasoning
};

// Evidence
type EvidenceContent = {
  finding: string;                  // "OMDIA forecasts $2.26B by 2028 at 10.4% CAGR"
  supports: 'for' | 'against' | 'mixed';
  strength: 'weak' | 'moderate' | 'strong';
  sourceQuote?: string;             // verbatim if useful
};

// Question (HITL)
type QuestionContent = {
  question: string;
  type: 'yes_no' | 'yes_no_context' | 'open';
  options?: string[];
  needed_because: string;           // why the agent flagged this
};
```

---

## 6. Agent Contracts

Every agent is a TypeScript async function with a typed input and output. No agent framework, no LangGraph — just functions that return data and let the orchestrator decide what to do with it. Each agent specifies which model it uses; that mapping lives in `lib/llm-client.ts`.

### 6.1 Brief Parser (v1: stub, returns config)

```ts
type ParsedBrief = {
  thresholds: Record<string, number | string>;
  constraints: string[];
  weights: Record<string, number>;
  infoGaps: string[];
  risks: { description: string; likelihood: string; impact: string }[];
  stakeholderQuestions: string[];
  documentProvenance: { sourceId: string; author?: string; stake?: string }[];
};

async function parseBrief(briefText: string, deckText?: string): Promise<ParsedBrief>;
```

For v1, this returns hardcoded values from `cases/abb-rack-pdu.yaml`. v2 makes it a real LLM call.

### 6.2 Framework Binder (v1: hardcoded)

```ts
type FrameworkBinding = {
  frameworkId: string;
  slots: { id: string; templateClaim: string; weight: number }[];
};

async function bindFramework(question: string, parsed: ParsedBrief): Promise<FrameworkBinding>;
```

For v1, returns the GE 9-box + Make-Buy-Ally binding from `frameworks/`. v2 picks dynamically.

### 6.3 Tree Builder (Sonnet)

```ts
async function buildTree(
  caseId: string,
  binding: FrameworkBinding,
  parsed: ParsedBrief
): Promise<TreeNode[]>;
```

Instantiates the framework into hypothesis nodes. Decomposes Tier 1 hypotheses into 2–3 sub-hypotheses each. Writes nodes to DB with `status='pending'`, no evidence yet.

### 6.4 Evidence Agent (Mistral / Gemini / Sonnet, mixed)

```ts
type EvidenceMode = 'web' | 'doc' | 'question';

async function gatherEvidence(
  hypothesis: TreeNode,
  mode: EvidenceMode,
  caseContext: { sources: Source[]; question: string }
): Promise<EvidenceNode[]>;
```

Three modes run in parallel per leaf:
- `web`: Tavily query, 3–5 results, each becomes an EvidenceNode with source linkage
- `doc`: pgvector retrieval against ingested PDFs/DOCX, top-k chunks
- `question`: only fires if web+doc come back with low strength; produces a QuestionNode child

Model assignment: `web` → Mistral (cheap, parallel); `doc` → Gemini (long context); `question` → Sonnet (judgment); `evaluator` → Sonnet (judgment); `decision` → Opus (final).

### 6.5 Hypothesis Evaluator (Sonnet)

```ts
async function evaluateHypothesis(
  hypothesisId: string
): Promise<{ confidence: number; evidenceStrength: number; rationale: string }>;
```

Reads the hypothesis's evidence children, weighs supporting vs contradicting, returns confidence 0–1 with reasoning. Updates the hypothesis node in DB.

### 6.6 Confidence Rollup (deterministic, no LLM)

```ts
function rollupConfidence(tree: TreeNode[], weights: Record<string, number>): TreeNode[];
```

For sub-hypothesis → hypothesis: weighted average using slot weights from framework.
For hypothesis → decision: weighted product (AND-aggregation) using the case's Section 5 weights, with weakest-link tracking.

### 6.7 Master Decision Agent (Opus)

```ts
async function decide(caseId: string): Promise<DecisionContent>;
```

Reads top-level hypotheses with their confidences and weights. Outputs final decision + reasoning + weakest-link callout + per-threshold pass/fail.

### 6.8 Run Orchestrator

```ts
async function runCase(caseId: string, scenarioId?: string): Promise<RunResult>;
```

Pipeline: parseBrief → bindFramework → buildTree → fanout(gatherEvidence) → forEach(evaluateHypothesis) → rollupConfidence → decide. Writes status updates to `runs` table for UI subscription.

---

## 7. Framework Registry & Case Config

### 7.1 Framework format (`frameworks/*.yaml`)

```yaml
id: ge-9-box-with-make-buy-ally
name: GE Market Attractiveness × Make-Buy-Ally
applicableTo: [market-entry-with-mode]
tiers:
  - id: tier-1
    name: Should we pursue?
    type: AND-gate
    slots:
      - id: market-attractive
        templateClaim: "The accessible market in [SCOPE] is large and growing enough to clear [THRESHOLD] within [TIMEFRAME]"
        weight: 0.25                  # overridable by case config
        decomposition:
          - "TAM-SAM-SOM bridge clears threshold"
          - "Growth trajectory is favourable"
          - "Sub-segment mix is favourable"
      - id: can-win
        templateClaim: "[COMPANY] can build a winning product in [PRODUCT]"
        weight: 0.20
        decomposition:
          - "Capability gap is closeable"
          - "Brand permission exists in target segments"
          - "Cost position is competitive"
      - id: can-reach
        templateClaim: "[COMPANY] can reach customers fast enough via available channels"
        weight: 0.15
      - id: financials-clear
        templateClaim: "Unit economics and investment clear [COMPANY]'s IRR hurdle"
        weight: 0.20
      - id: tech-resilient
        templateClaim: "The product will not be obsolete within [TIMEFRAME]"
        weight: 0.20
  - id: tier-2
    name: Build, buy, or partner?
    type: COMPARATIVE
    activatesIf: tier-1.confidence > 0.6
    options: [build, buy, partner]
    criteria: [speed, control, capability_fit, capital, risk]
```

### 7.2 Case config (`cases/abb-rack-pdu.yaml`)

```yaml
caseId: abb-rack-pdu
title: ABB Rack PDU Market Entry
question: "Should ABB pursue the rack PDU business, and if yes, should it be built internally, acquired, or partnered into?"
frameworkId: ge-9-box-with-make-buy-ally

substitutions:
  COMPANY: ABB
  PRODUCT: rack PDU (with emphasis on intelligent/managed segment)
  SCOPE: global data center market, accessible geographies excluding restricted markets
  THRESHOLD: $100M/year revenue
  TIMEFRAME: 3 years

weights:
  marketSize: 0.25
  techResilience: 0.25
  roi: 0.20
  timeToMarket: 0.15
  strategicFit: 0.15

thresholds:
  minRevenue: 100000000
  timeYears: 3
  irrHurdle: 0.15
  internalDevMaxYears: 3

inputDocs:
  - path: docs/abb-case-brief.pdf
    type: brief
    author: Innovera
    stake: neutral-advocate
  - path: docs/abb-rack-pdu-deck.pdf
    type: pitch
    author: ABB Energy Distribution BL
    stake: pre-disposed-favourable      # noted: slide 6 pre-concludes
```

---

## 8. ABB v1 Instantiation

Tree shape Victor must produce on the ABB case:

```
Decision: Should ABB pursue rack PDU? If yes, how?
├── H1: Accessible market clears $100M/3yr threshold (weight 0.25)
│   ├── SH1.1: TAM-SAM-SOM bridge supports $100M
│   ├── SH1.2: Growth trajectory is favourable
│   └── SH1.3: Intelligent vs basic mix favours ABB entry
├── H2: ABB can build a winning product (weight 0.20)
│   ├── SH2.1: Intelligent PDU capability gap is closeable
│   └── SH2.2: Brand has permission in target segments
├── H3: ABB can reach IT-channel customers fast enough (weight 0.15)
│   ├── SH3.1: Existing electrical channels are insufficient
│   └── SH3.2: Acquisition or partnership opens IT channels
├── H4: Unit economics clear ABB's IRR hurdle (weight 0.20)
│   ├── SH4.1: Achievable margins (25–30% claim) are credible
│   └── SH4.2: Investment vs revenue ramp clears hurdle
└── H5: Product will not be obsolete within 3 years (weight 0.25, given TechResilience)
    ├── SH5.1: 25kW+ migration timeline is manageable
    └── SH5.2: DC distribution disruption is unlikely in window

Tier 2 (only if Tier 1 weighted confidence > 0.6):
Build vs Buy vs Partner scored across speed, control, capability fit, capital, risk
```

Total leaves: 11 sub-hypotheses + 5 evaluable Tier-2 dimensions. Roughly 30–45 evidence nodes after fanout.

---

## 9. Repo Structure

```
agent-victor/
├── app/
│   ├── api/
│   │   ├── cases/route.ts
│   │   ├── runs/[id]/route.ts
│   │   └── questions/[id]/route.ts
│   ├── case/[id]/page.tsx
│   └── page.tsx
├── agents/
│   ├── orchestrator.ts
│   ├── brief-parser.ts
│   ├── framework-binder.ts
│   ├── tree-builder.ts
│   ├── evidence/
│   │   ├── web-search.ts
│   │   ├── doc-retrieval.ts
│   │   └── question-generator.ts
│   ├── evaluator.ts
│   ├── rollup.ts
│   └── decision.ts
├── lib/
│   ├── db.ts                     # Backend abstraction (InsForge or Supabase)
│   ├── llm-client.ts             # OpenRouter or InsForge Gateway
│   ├── search.ts                 # Tavily wrapper
│   ├── ingest.ts                 # PDF/DOCX → chunks → embeddings
│   ├── schema.ts                 # TypeScript types matching DB
│   └── framework-registry.ts
├── frameworks/
│   ├── ge-9-box-make-buy-ally.yaml
│   └── (more in v2)
├── cases/
│   └── abb-rack-pdu.yaml
├── components/
│   ├── KanbanBoard.tsx
│   ├── TreeNode.tsx
│   ├── ConfidenceMeter.tsx
│   ├── EvidenceModal.tsx
│   ├── SourceViewer.tsx
│   └── QuestionList.tsx
├── docs/
│   ├── abb-case-brief.pdf
│   └── abb-rack-pdu-deck.pdf
├── schema.sql
├── SPEC.md                       # this file
├── README.md
└── .env.example
```

---

## 10. Environment Variables

```
# Backend (use one set)
INSFORGE_PROJECT_URL=
INSFORGE_API_KEY=
# OR
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=

# LLM access (OpenRouter route)
OPENROUTER_API_KEY=
ANTHROPIC_API_KEY=
MISTRAL_API_KEY=
GOOGLE_API_KEY=

# Search
TAVILY_API_KEY=

# Optional for v2
OPENAI_API_KEY=
```

---

## 11. Thread Plan

Each thread receives this SPEC plus its own brief. Output is delivered as a Claude Code task spec following the template in §11.1.

| Thread | Title | Depends On | Phase |
| --- | --- | --- | --- |
| AV-00 | Master spec & data model | — | Foundation |
| AV-01 | ABB framework + case config files | AV-00 | Foundation |
| AV-02 | Document ingestion + pgvector | AV-00 | Foundation |
| AV-03 | Evidence agents (web + doc + question) | AV-00, AV-02 | Pipeline |
| AV-04 | Evaluators + confidence rollup + decision | AV-00 | Pipeline |
| AV-05 | Kanban overview + tree expansion | AV-04 producing data | UI |
| AV-06 | Drill-down + source modals | AV-05 | UI |
| AV-07 | Multi-model + HITL question batching | AV-03, AV-04 | Polish |
| AV-08 | Demo prep | All above | Polish |

### 11.1 Per-thread output template (hand to Claude Code)

```markdown
# AV-XX: [Title]

## Goal
One-sentence statement of what this thread produces.

## Inputs (already in repo)
- Files / functions / endpoints from prior threads
- Reference to specific SPEC.md sections

## Outputs
- Files to create or modify, with paths
- Functions to expose, with signatures from §6

## Acceptance Criteria
- Bulleted, testable
- Each one a yes/no the human can verify in <5 minutes

## Out of Scope
- Explicit list of what NOT to build
- Prevents Claude Code from scope-creeping into adjacent threads

## Open Questions
- Anything to resolve with the human before kickoff
```

---

## 12. Acceptance Criteria for v1 Demo

The demo passes if all of these are true on Day 14:

1. User opens the app, selects "ABB Rack PDU" from a list of preloaded cases (no upload UI required for v1)
2. User clicks "Run" and sees a progress indicator
3. Within 10 minutes (or instantly if pre-cached), the tree renders in Kanban view with confidence meters on every card
4. The decision card shows a final recommendation, weighted confidence, and a "weakest link" callout pointing to a specific hypothesis
5. Clicking any hypothesis card expands it into a tree view showing sub-hypotheses with their own confidence scores
6. Clicking any sub-hypothesis shows the evidence backing it
7. Clicking any evidence opens a modal with the actual source — for web sources, the URL and quoted passage; for PDF sources, the page number and a highlighted region
8. The drill-down click path works without errors: Decision → Hypothesis → Sub-hyp → Evidence → Source
9. Confidence math is correct (manually verifiable on at least one branch): weighted average for sub→hyp, weighted product for hyp→decision
10. The OMDIA chart on page 8 of the ABB deck appears as evidence under H1 ("market is attractive") with the 10.4% CAGR figure called out

Demo failure modes to actively prevent: tree partial-render due to one failed agent (use `Promise.allSettled` and show "evidence pending" rather than crash), source modal failing to load (cache resolved sources at run time, don't fetch on click), confidence display flickering during rollup (write final values transactionally).

---

## 13. Out of Scope for v1

Defer all of these to v2 with a roadmap slide:

- Multiple frameworks (only ABB binding ships)
- Live brief parser as an LLM call (config file only)
- Live framework selector (hardcoded only)
- Hypothesis critic agent (templates assumed correct)
- Red team agent (mention in slide; build in v2)
- Scenario / digital twin layer (the killer feature; demo it as a v2 mockup)
- Multi-tenant auth (single user OK)
- File upload UI (preload ABB docs)
- Persistent run history beyond the demo run
- Mobile responsive (desktop only for the demo)
- Export to deck/doc (manual for v1)

---

## 14. v2 Roadmap (One Slide)

For the demo close, frame as "what comes next":

1. **Brief parser as a real LLM step** — auto-extract thresholds, constraints, weights, info gaps, stakeholder bias from any uploaded brief
2. **Framework selector + library expansion** — 10 curated frameworks, agent picks the right one(s) per question
3. **Hypothesis critic** — rejects vague claims before they ship
4. **Red team agent** — runs in parallel, attacks the emerging conclusion, adds a confidence stress-test
5. **Scenario layer** — inject a new fact ("regulatory change in EU"), full re-run, diff view shows which leaves moved
6. **Multi-model parallelism** — every leaf tested by 2–3 models, disagreement itself becomes a flag
7. **Knowledge-graph backend** — when complexity warrants, move from JSONB-on-Postgres to a graph DB; node/edge model already designed for it
8. **Persistent case workspace** — return to a case, add new docs, ask follow-up questions of the tree

---

## 15. Non-Negotiables

These are the things that make Victor *Victor* rather than a generic AI report tool. Threads cannot trade them away:

1. **Frameworks are curated, not generated.** No ad-hoc tree generation.
2. **Hypotheses are templated.** Every leaf claim instantiates a framework slot, not a free-form sentence.
3. **Confidence is weighted, not averaged.** Section 5 weights drive rollup math.
4. **Every evidence node has provenance.** No floating claims. Source modal must work.
5. **The drill-down click path is the demo.** UI work serves this.
6. **Documents are tagged with stake.** Brief from Innovera, deck from ABB advocate — Victor knows the difference.

---

*End of SPEC.md. Open to revision via this thread only.*
