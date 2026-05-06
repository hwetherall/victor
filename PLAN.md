Memory is empty — no prior context to load. Now I'll produce the full breakdown.

---

# Project: Agent Victor (Codename "viktor")

## Summary

Agent Victor is a 14-day demo build of an AI-powered strategic decision framework tool. It takes the ABB Rack PDU case as its single v1 subject: a structured question is decomposed into a MECE hypothesis tree using the GE 9-Box + Make-Buy-Ally framework, evidence is gathered from uploaded PDF/DOCX sources and live web search, confidence scores are rolled up through the tree using weighted aggregation, and a Master Decision Agent (Opus) delivers a final recommendation the user can audit click-by-click down to original source citations.

The backend is InsForge (already provisioned: project `b3ce8f41`, app key `jad7z9v9`, live at `jad7z9v9.us-west.insforge.app`). The repo is currently empty except for `SPEC.md` and the `.insforge` project config — every file must be created from scratch.

The single demo-critical deliverable is the **drill-down click path**: Decision → Hypothesis → Sub-hypothesis → Evidence → Source. Everything else is subordinate to making that path work flawlessly by Day 14.

---

## Assumptions

1. InsForge exposes a Postgres-compatible SQL interface and pgvector extension, consistent with SPEC §4 and §5.
2. The InsForge SDK is installable as an npm package and provides the same read/write primitives as the Supabase JS client (the SPEC calls out Apache 2.0 / self-hostable lineage, implying close API surface).
3. The ABB PDF documents (`abb-case-brief.pdf` and `abb-rack-pdu-deck.pdf`) exist on Harry's machine and can be placed in the `docs/` directory before Day 3 ingestion work begins.
4. The OMDIA chart is on page 8 of `abb-rack-pdu-deck.pdf` and the 10.4% CAGR text appears in that page's content (either as selectable text or in surrounding copy) so the doc-retrieval agent can surface it.
5. "Pre-cached run" for the Day 14 demo means the pipeline has already been executed and results are stored in InsForge — clicking "Run" will return the cached result rather than re-executing agents live.
6. Vercel deployment is available and configured for the org; Harry has access to push and set environment variables.
7. The `insforge` and `insforge-cli` Claude Code skills are available in this project, which will accelerate SDK wiring stories.
8. Single-engineer cadence: stories are sized for Harry working alone (or with Claude Code as copilot), not a team.

---

## Resolved Decisions (locked 2026-05-05 by Harry)

All six open questions answered. Stories below assume these.

| # | Decision | Implications |
|---|----------|--------------|
| Q1 | **LLM gateway: OpenRouter** | STORY-005 implements OpenRouter only — no InsForge Model Gateway branch. Single key `OPENROUTER_API_KEY`. Anthropic SDK direct can still be used for Sonnet/Opus to enable prompt caching if cheaper; any direct path is wrapped behind `lib/llm-client.ts`. |
| Q2 | **Pre-cached = result-cached run replayed instantly** | STORY-037 builds `GET /api/cases/[id]/runs/latest`. On demo day, "View Results" loads from InsForge with no agent invocations. No prompt-cache-warmed live run. |
| Q3 | **HITL: skipped entirely for v1** | **EPIC-006 is dropped.** STORY-025 stays as a permanent no-op stub so the agent interface is complete. `user_questions` table exists in schema but is never written to. `QuestionList.tsx` is not built. `runs.status='awaiting_input'` is never set. |
| Q4 | **ABB PDFs ready** | EPIC-002 unblocked from Day 1. Drop both PDFs into `docs/` before STORY-010. |
| Q5 | **Tree Builder: config-driven stub** | STORY-016 hardcodes the SPEC §8 tree shape. No Sonnet call. Deterministic and demo-safe. |
| Q6 | **Tier 2 (Build/Buy/Partner) in scope, gated on Tier 1** | Decision card must include a Build/Buy/Partner recommendation, **but only if rolled-up Tier 1 confidence > 0.6** (SPEC §8 `activatesIf`). If Tier 1 fails, decision card says "Do not pursue rack PDU" and Tier 2 is skipped entirely. Adds STORY-019b (Tier 2 evaluator) to EPIC-003 and expands STORY-019 acceptance criteria to handle the conditional merge. |

---

## Epic Overview & Dependency Map

```
EPIC-001 (AV-00/01): Foundation & Scaffolding
    └──► EPIC-002 (AV-02): Document Ingestion & Embeddings
    └──► EPIC-003 (AV-01/04): Pipeline Core (agents + rollup + decision)
              └──► EPIC-004 (AV-03): Evidence Agents (web + doc)
              └──► EPIC-005 (AV-05/06): UI — Kanban + Drill-Down
                        └──► EPIC-006 (AV-07a): HITL Question Batching [DROPPABLE]
                        └──► EPIC-007 (AV-08): Demo Prep
EPIC-008 (AV-07b): Multi-Model Routing [DROPPABLE]
```

Recommended execution order respects this DAG and front-loads the vertical slice.

---

## Thread-to-Epic Mapping

| SPEC Thread | Epic | Rationale for Change |
|-------------|------|----------------------|
| AV-00 (Master spec) | EPIC-001 | Absorbed into Foundation; spec already exists |
| AV-01 (ABB config files) | EPIC-001 | Co-located with scaffolding; both are Day 1–2 |
| AV-02 (Ingest + pgvector) | EPIC-002 | Kept as own epic; significant standalone work |
| AV-03 (Evidence agents) | EPIC-004 | Separated from evaluators for cleaner dependency |
| AV-04 (Evaluators + rollup + decision) | EPIC-003 | Renamed "Pipeline Core" — these run before evidence fanout |
| AV-05 (Kanban overview) | EPIC-005 | Merged AV-05 and AV-06 into one UI epic |
| AV-06 (Drill-down + source modals) | EPIC-005 | Merged with AV-05; both need the same data layer |
| AV-07 (Multi-model + HITL) | EPIC-008 + EPIC-006 | Split: multi-model is droppable independently of HITL |
| AV-08 (Demo prep) | EPIC-007 | Kept as own epic |

---

## EPIC-001: Foundation & Scaffolding (AV-00 + AV-01)

**User Value**: The repo exists. A developer can clone it, run `npm install`, set env vars, and see a Next.js app load in the browser. The database schema is live in InsForge. The ABB case config and framework YAML are in place. This epic produces no visible product feature but is the precondition for all other epics.

**Dependencies**: None

**Estimated Total Effort**: ~7 days-work across stories, compressed to 2 calendar days with parallel effort

**Maps to SPEC**: §4 (tech stack), §5 (schema), §7 (framework registry), §9 (repo structure), §10 (env vars)

---

### STORY-001: Next.js 15 project init with TypeScript and Tailwind

- **Type**: Technical Story
- **Statement**: As a developer, I need a runnable Next.js 15 App Router project with TypeScript and Tailwind configured so that all subsequent stories have a working build target.
- **Acceptance Criteria**:
  - [ ] `npx create-next-app@latest` (or equivalent) produces the project in the `viktor/` directory with App Router, TypeScript, and Tailwind selected
  - [ ] `npm run dev` starts without errors and loads a placeholder homepage at `localhost:3000`
  - [ ] `npm run build` completes without TypeScript errors
  - [ ] `.gitignore` covers `node_modules`, `.next`, `.env.local`
  - [ ] `package.json` name is `agent-victor`
- **Complexity**: Small
- **Dependencies**: None
- **Notes**: Use `--no-git` flag since the repo directory already exists. Confirm App Router (not Pages Router). Do not add any extra libraries at this stage — dependencies are added in the stories that need them.

---

### STORY-002: InsForge SDK install and `lib/db.ts` client

- **Type**: Technical Story
- **Statement**: As a developer, I need the InsForge SDK installed and a typed `lib/db.ts` client module so that all agents and API routes can read and write to the InsForge Postgres backend without duplicating connection logic.
- **Acceptance Criteria**:
  - [ ] `@insforge/sdk` (or equivalent package name) is in `package.json` dependencies
  - [ ] `lib/db.ts` exports a singleton InsForge client initialized from `INSFORGE_PROJECT_URL` and `INSFORGE_API_KEY` env vars
  - [ ] A smoke-test script (or a test API route at `/api/health`) does a basic `SELECT 1` against the InsForge DB and returns `{ ok: true }` when env vars are set
  - [ ] `.env.example` contains `INSFORGE_PROJECT_URL` and `INSFORGE_API_KEY` with blank values and a comment
  - [ ] No Supabase packages are installed
- **Complexity**: Small
- **Dependencies**: STORY-001
- **Notes**: The InsForge project is already provisioned (`project_id: b3ce8f41`, `appkey: jad7z9v9`). Use the `insforge` Claude Code skill to confirm the correct SDK package name and client initialization pattern. `lib/db.ts` targets InsForge directly — no abstraction layer for backend swapping.

---

### STORY-003: Database schema deployment (`schema.sql`)

- **Type**: Technical Story
- **Statement**: As a developer, I need the full database schema from SPEC §5.1 applied to the InsForge project so that all tables (`cases`, `tree_nodes`, `sources`, `evidence_sources`, `user_questions`, `runs`) and indexes (including the pgvector IVFFlat index on `sources.embedding`) exist and are queryable.
- **Acceptance Criteria**:
  - [ ] `schema.sql` exists at the repo root and matches SPEC §5.1 exactly (all tables, constraints, indexes)
  - [ ] Schema is applied to the InsForge project (via InsForge CLI migration or direct SQL execution)
  - [ ] `pgvector` extension is enabled; `vector(1536)` column on `sources` is confirmed present
  - [ ] All six tables are visible and selectable in the InsForge dashboard or via a `\dt` equivalent
  - [ ] A manual INSERT + SELECT round-trip on `cases` succeeds
- **Complexity**: Small
- **Dependencies**: STORY-002
- **Notes**: Use `insforge-cli` skill for the migration command. The IVFFlat index (`create index on sources using ivfflat (embedding vector_cosine_ops)`) requires pgvector to be enabled first — order matters in the SQL file.

---

### STORY-004: TypeScript type library (`lib/schema.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need TypeScript interfaces that match every DB table and every `content` payload shape (SPEC §5.2) so that agents and API routes are type-safe without runtime casting.
- **Acceptance Criteria**:
  - [ ] `lib/schema.ts` exports interfaces: `Case`, `TreeNode`, `Source`, `EvidenceSource`, `UserQuestion`, `Run`
  - [ ] `lib/schema.ts` exports content payload types: `DecisionContent`, `HypothesisContent`, `EvidenceContent`, `QuestionContent` (SPEC §5.2)
  - [ ] All enum fields (`type`, `status`) are typed as string literals, not plain `string`
  - [ ] `TreeNode.content` is typed as `DecisionContent | HypothesisContent | EvidenceContent | QuestionContent` discriminated by `type`
  - [ ] No runtime type-checking library needed — types are compile-time only
- **Complexity**: Small
- **Dependencies**: STORY-003
- **Notes**: Keep this file pure types — no imports from InsForge SDK. This file is consumed by everything else.

---

### STORY-005: LLM client abstraction (`lib/llm-client.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need a typed `lib/llm-client.ts` module that wraps the chosen LLM gateway (OpenRouter or InsForge Model Gateway — see Open Question Q1) so that agents call a single `complete(model, prompt, options)` function and model-routing decisions are centralized.
- **Acceptance Criteria**:
  - [ ] `lib/llm-client.ts` exports `async function complete(model: LLMModel, messages: Message[], options?: CompletionOptions): Promise<string>`
  - [ ] `LLMModel` is a string literal union: `'claude-sonnet-4-5' | 'claude-opus-4' | 'mistral-large' | 'gemini-pro'` (adjust model slugs to match gateway's naming)
  - [ ] A MODEL_MAP constant maps agent roles (`'evidence-web' | 'evidence-doc' | 'evaluator' | 'decision'`) to `LLMModel` values per SPEC §6.4
  - [ ] A single API key env var (either `OPENROUTER_API_KEY` or InsForge gateway credential) is the only runtime dependency
  - [ ] A smoke-test with a trivial prompt against Sonnet returns a non-empty string
  - [ ] `.env.example` updated with the chosen gateway's key
- **Complexity**: Medium
- **Dependencies**: STORY-001
- **Notes**: This story is blocked on Open Question Q1 (LLM gateway choice). If Q1 is unresolved, implement for OpenRouter first (simpler, well-documented) and note that the MODEL_MAP is the only change needed to swap. Use Anthropic direct SDK for Sonnet/Opus calls to enable prompt caching (SPEC non-negotiable: Opus for decision, Sonnet for evaluator).

---

### STORY-006: Tavily search wrapper (`lib/search.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need a `lib/search.ts` module that wraps the Tavily search API so that evidence agents can issue a search query and receive a typed list of results without knowing the Tavily HTTP contract.
- **Acceptance Criteria**:
  - [ ] `lib/search.ts` exports `async function search(query: string, maxResults?: number): Promise<SearchResult[]>`
  - [ ] `SearchResult` type has `title: string`, `url: string`, `snippet: string`, `content?: string`
  - [ ] Default `maxResults` is 5 (matching SPEC §6.4: "3–5 results")
  - [ ] `TAVILY_API_KEY` is read from env; an error is thrown at call-time (not module load) if missing
  - [ ] `.env.example` updated with `TAVILY_API_KEY`
  - [ ] A smoke-test query ("rack PDU market size 2024") returns at least 1 result
- **Complexity**: Small
- **Dependencies**: STORY-001
- **Notes**: Tavily has a Node.js SDK (`@tavily/core`). Use it rather than raw `fetch` to avoid reimplementing auth headers.

---

### STORY-007: Framework YAML and case config files

- **Type**: Technical Story
- **Statement**: As a developer, I need `frameworks/ge-9-box-make-buy-ally.yaml` and `cases/abb-rack-pdu.yaml` created exactly as specified in SPEC §7.1 and §7.2 so that the Framework Binder and Tree Builder have their config inputs available.
- **Acceptance Criteria**:
  - [ ] `frameworks/ge-9-box-make-buy-ally.yaml` matches SPEC §7.1 exactly: both tiers, all five tier-1 slots with weights and decomposition arrays, tier-2 with activatesIf and options
  - [ ] `cases/abb-rack-pdu.yaml` matches SPEC §7.2 exactly: substitutions, weights, thresholds, inputDocs list
  - [ ] `lib/framework-registry.ts` exports `loadFramework(id: string): Framework` that reads and parses the YAML file, returning a typed `Framework` object
  - [ ] `lib/framework-registry.ts` exports `loadCase(caseId: string): CaseConfig` that reads and parses the case YAML
  - [ ] Both functions throw a descriptive error if the file is not found
  - [ ] `yaml` or `js-yaml` package added to dependencies
- **Complexity**: Small
- **Dependencies**: STORY-004
- **Notes**: The `Framework` and `CaseConfig` TypeScript types should be defined in `lib/schema.ts` (or a separate `lib/framework-types.ts`). Keep YAML as the source of truth — don't hardcode the data in TypeScript.

---

### STORY-008: Environment variable validation and `.env.example`

- **Type**: Technical Story
- **Statement**: As a developer, I need all required environment variables documented in `.env.example` and validated at application startup so that a missing key fails loudly at boot rather than silently at runtime.
- **Acceptance Criteria**:
  - [ ] `.env.example` lists every env var from SPEC §10 (InsForge set only — not Supabase), plus `TAVILY_API_KEY` and the chosen LLM gateway key, each with a comment explaining its purpose
  - [ ] A `lib/config.ts` module (or equivalent) reads all required vars using a validation approach (e.g., plain guard or `zod`); throws at module load if any required var is missing
  - [ ] Running `npm run dev` with a missing `INSFORGE_API_KEY` shows a clear error message naming the missing variable, not a cryptic downstream failure
  - [ ] `lib/db.ts` and `lib/llm-client.ts` import from `lib/config.ts` rather than reading `process.env` directly
- **Complexity**: Small
- **Dependencies**: STORY-005, STORY-002
- **Notes**: Avoid pulling in a heavy validation library just for this. A 10-line guard function is fine. Zod is acceptable if it's already in the project for other purposes.

---

### STORY-009: Placeholder homepage and case list page

- **Type**: User Story
- **Statement**: As a user, I want to open the app and see a list of available cases (initially just "ABB Rack PDU") so that I can select a case and proceed to the run screen.
- **Acceptance Criteria**:
  - [ ] `app/page.tsx` renders a page with the title "Agent Victor" and a list showing at least one case: "ABB Rack PDU Market Entry"
  - [ ] The case list entry is a clickable link navigating to `/case/[id]` (hardcoded case ID for now)
  - [ ] The page uses Tailwind for basic styling (not unstyled HTML)
  - [ ] The `/case/[id]` route renders a placeholder page that shows the case title and a "Run" button (button is non-functional at this stage)
  - [ ] `npm run build` passes
- **Complexity**: Small
- **Dependencies**: STORY-001
- **Notes**: This is intentionally thin — it exists so there is a visible app from Day 1. Real case data and run wiring come in EPIC-005. The case list can be hardcoded; no DB call required yet.

---

## EPIC-002: Document Ingestion and Embeddings (AV-02)

**User Value**: The ABB brief and deck PDFs are chunked, embedded, and stored in InsForge with pgvector. Doc-retrieval evidence agents can query them. Acceptance criterion #10 (OMDIA chart, 10.4% CAGR) depends on this epic being correct.

**Dependencies**: EPIC-001 (needs `lib/db.ts`, `schema.sql` with pgvector, `lib/schema.ts`)

**Estimated Total Effort**: 3–5 days

**Maps to SPEC**: §6.4 (doc mode), §5.1 (sources table), acceptance criterion #10

---

### STORY-010: PDF text extraction and chunking (`lib/ingest.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `lib/ingest.ts` to extract text from a PDF file, split it into overlapping chunks of ~500 tokens with page-number tracking, so that each chunk can be embedded independently and page citations work in the source modal.
- **Acceptance Criteria**:
  - [ ] `lib/ingest.ts` exports `async function ingestPDF(filePath: string, caseId: string, metadata: SourceMetadata): Promise<Source[]>`
  - [ ] Each returned `Source` has `content_extract` (the chunk text), `metadata.pageNumber`, `metadata.author`, `metadata.stake`, and `uri` (the file path)
  - [ ] Chunk size is ~500 tokens (approximate; word-count-based is acceptable for v1)
  - [ ] Overlapping window of ~50 tokens between adjacent chunks to avoid splitting mid-sentence
  - [ ] Running against `docs/abb-rack-pdu-deck.pdf` produces at least 10 chunks with non-empty `content_extract`
  - [ ] `pdf-parse` or `pdfjs-dist` added to dependencies
- **Complexity**: Medium
- **Dependencies**: STORY-004
- **Notes**: Page-number tracking is critical for acceptance criterion #7 (PDF source modal shows page number). The chunk metadata must carry `pageNumber: number` through to the DB. DOCX ingestion is listed in the schema but not required for v1 (both ABB input docs are PDFs — see SPEC §7.2). Flag DOCX as a stub returning an error for now.

---

### STORY-011: Embedding generation and source storage

- **Type**: Technical Story
- **Statement**: As a developer, I need each ingested chunk to be embedded using a 1536-dimension embedding model and stored in the `sources` table with its vector so that pgvector similarity search works.
- **Acceptance Criteria**:
  - [ ] `lib/ingest.ts` (extended from STORY-010) calls an embedding API to produce a `vector(1536)` for each chunk
  - [ ] Embedding is stored in `sources.embedding` column
  - [ ] `sources.type` is set to `'pdf'`
  - [ ] A similarity query `SELECT id, title FROM sources ORDER BY embedding <=> $query_vector LIMIT 5` returns the 5 most relevant chunks from the ABB deck
  - [ ] The embeddings API key (OpenAI `text-embedding-3-small` or equivalent) is in `.env.example`
  - [ ] Running the ingest script twice does not create duplicates (check `uri` + `case_id` for deduplication)
- **Complexity**: Medium
- **Dependencies**: STORY-010, STORY-003
- **Notes**: OpenAI `text-embedding-3-small` outputs 1536 dimensions and is cheap. If the InsForge Model Gateway provides an embedding endpoint, prefer it (aligns with Q1). The deduplication check is important because the ingest script will likely be re-run during development.

---

### STORY-012: Document ingest script and OMDIA chunk verification

- **Type**: Technical Story
- **Statement**: As a developer, I need a runnable script (`scripts/ingest-abb.ts`) that ingests both ABB documents into InsForge with the correct metadata (author, stake from `cases/abb-rack-pdu.yaml`), so that the ingest pipeline is reproducible and the OMDIA evidence chunk is confirmed present.
- **Acceptance Criteria**:
  - [ ] `scripts/ingest-abb.ts` reads both PDFs from `docs/`, calls `ingestPDF` for each, and prints a summary: number of chunks ingested per file, any errors
  - [ ] `package.json` has a `scripts.ingest` entry: `"ingest": "npx ts-node scripts/ingest-abb.ts"`
  - [ ] After running `npm run ingest`, `sources` table contains rows for both documents with correct `metadata.author` and `metadata.stake` values matching `cases/abb-rack-pdu.yaml`
  - [ ] A manual similarity search with query "OMDIA rack PDU CAGR forecast" returns a chunk from `abb-rack-pdu-deck.pdf` containing the text "10.4%" (verifying acceptance criterion #10's data is in the DB)
  - [ ] The script is idempotent: running it twice produces no duplicate rows
- **Complexity**: Medium
- **Dependencies**: STORY-011, STORY-007
- **Notes**: This story is the acceptance test for the entire ingestion epic. If the OMDIA chunk is not surfaced by this similarity search, the doc-retrieval evidence agent will never surface it for H1. Debugging this now (Day 3–4) is far better than discovering it on Day 13. The `ts-node` or `tsx` runner should be added to devDependencies.

---

### STORY-013: Doc-retrieval query function (`lib/ingest.ts` extension)

- **Type**: Technical Story
- **Statement**: As a developer, I need a `retrieveEvidence(query: string, caseId: string, topK: number): Promise<Source[]>` function that runs a pgvector similarity search so that the doc-retrieval evidence agent (STORY-022) can call it without knowing the SQL.
- **Acceptance Criteria**:
  - [ ] Function is exported from `lib/ingest.ts` (or a new `lib/retrieval.ts`)
  - [ ] Accepts a natural-language query, embeds it using the same embedding model as STORY-011, runs `ORDER BY embedding <=> $queryVec LIMIT topK` against `sources` filtered by `case_id`
  - [ ] Returns `Source[]` with `content_extract`, `metadata.pageNumber`, `uri`, `title` populated
  - [ ] A direct call with `query="intelligent PDU market size growth rate"` and `caseId` of the ABB case returns at least 3 chunks, one of which contains "10.4%" or "CAGR"
  - [ ] `topK` defaults to 5
- **Complexity**: Small
- **Dependencies**: STORY-011
- **Notes**: This is the interface the evidence agent will call. Keep it simple — no re-ranking, no hybrid search for v1.

---

## EPIC-003: Pipeline Core — Agents, Rollup, Decision (AV-00 + AV-04)

**User Value**: The core analytical engine works. Given the ABB case config, the system can build the hypothesis tree (SPEC §8), evaluate hypotheses, roll up confidence scores using weighted aggregation, and produce a Master Decision with a weakest-link callout. This epic does not yet wire real evidence — it uses stub evidence — but it proves the math and the data flow end-to-end.

**Dependencies**: EPIC-001 (needs `lib/db.ts`, `lib/llm-client.ts`, `lib/schema.ts`, `lib/framework-registry.ts`)

**Estimated Total Effort**: 4–6 days

**Maps to SPEC**: §6.1 through §6.8, §8 (ABB tree shape), acceptance criterion #9 (confidence math)

---

### STORY-014: Brief Parser stub (`agents/brief-parser.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/brief-parser.ts` to implement `parseBrief()` as a stub that returns the hardcoded values from `cases/abb-rack-pdu.yaml` so that the orchestrator can call it without a live LLM call.
- **Acceptance Criteria**:
  - [ ] `agents/brief-parser.ts` exports `async function parseBrief(briefText: string, deckText?: string): Promise<ParsedBrief>` matching the SPEC §6.1 signature
  - [ ] Function reads `cases/abb-rack-pdu.yaml` via `lib/framework-registry.ts` and returns a `ParsedBrief` with `thresholds`, `constraints`, `weights`, and `infoGaps` populated from the YAML
  - [ ] `stakeholderQuestions` is an empty array (no HITL for v1 stub)
  - [ ] `documentProvenance` lists the two ABB documents from `inputDocs` with their `author` and `stake`
  - [ ] Function signature is async even though it does no I/O, to match v2 interface
- **Complexity**: Small
- **Dependencies**: STORY-007, STORY-004
- **Notes**: SPEC §13 explicitly defers "live brief parser as LLM call" to v2. This stub is intentional. The function still reads from the YAML to avoid hardcoding values twice.

---

### STORY-015: Framework Binder stub (`agents/framework-binder.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/framework-binder.ts` to implement `bindFramework()` as a stub that returns the GE 9-Box + Make-Buy-Ally binding so that the orchestrator can call it without LLM invocation.
- **Acceptance Criteria**:
  - [ ] `agents/framework-binder.ts` exports `async function bindFramework(question: string, parsed: ParsedBrief): Promise<FrameworkBinding>` matching SPEC §6.2
  - [ ] Returns a `FrameworkBinding` with `frameworkId: 'ge-9-box-with-make-buy-ally'` and all five tier-1 slots loaded from the YAML via `lib/framework-registry.ts`
  - [ ] Each slot's `templateClaim` has substitutions applied: `[COMPANY]` → `ABB`, `[PRODUCT]` → `rack PDU (with emphasis on intelligent/managed segment)`, etc., using the `substitutions` map from `cases/abb-rack-pdu.yaml`
  - [ ] Weights on each slot match the YAML (`marketSize: 0.25`, etc.)
  - [ ] Weights sum to 1.00 (validated by a runtime assertion or unit test)
- **Complexity**: Small
- **Dependencies**: STORY-007, STORY-014
- **Notes**: SPEC §13 defers "live framework selector" to v2. Substitution logic is straightforward string replacement. A helper `applySubstitutions(template: string, subs: Record<string, string>): string` is worth extracting.

---

### STORY-016: Tree Builder — config-driven (`agents/tree-builder.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/tree-builder.ts` to build the full hypothesis tree from SPEC §8 and write it to the `tree_nodes` table so that the run has a persisted, traversable tree with correct parent-child relationships before any evidence is gathered.
- **Acceptance Criteria**:
  - [ ] `agents/tree-builder.ts` exports `async function buildTree(caseId: string, binding: FrameworkBinding, parsed: ParsedBrief): Promise<TreeNode[]>` matching SPEC §6.3
  - [ ] Produces exactly the tree from SPEC §8: 1 decision node + 5 hypothesis nodes (H1–H5) + 11 sub-hypothesis nodes (SH1.1–SH5.2), totaling 17 nodes
  - [ ] All nodes written to `tree_nodes` with `status='pending'`, correct `parent_id` linkages, and `type` values per SPEC §5.1
  - [ ] Hypothesis nodes have `weight` set from `FrameworkBinding.slots`
  - [ ] Decision node is the root (no `parent_id`); hypothesis nodes are children of the decision node; sub-hypothesis nodes are children of their respective hypothesis nodes
  - [ ] Returns the full array of created `TreeNode` objects
  - [ ] Function is config-driven (no Sonnet call — per discussion in Open Question Q5; stub approach consistent with SPEC §13)
- **Complexity**: Medium
- **Dependencies**: STORY-015, STORY-003
- **Notes**: The tree shape is fixed for v1. If Q5 is answered in favor of an LLM call, this story grows to Large and requires prompt engineering work. Config-driven is strongly recommended. Each sub-hypothesis label in SPEC §8 should match verbatim so the demo looks intentional.

---

### STORY-017: Hypothesis Evaluator (`agents/evaluator.ts`) with stub evidence

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/evaluator.ts` to implement `evaluateHypothesis()` as a Sonnet LLM call that reads a hypothesis's evidence children and returns a confidence score with reasoning, so that the evaluation step of the pipeline is functional even with stub evidence.
- **Acceptance Criteria**:
  - [ ] `agents/evaluator.ts` exports `async function evaluateHypothesis(hypothesisId: string): Promise<{ confidence: number; evidenceStrength: number; rationale: string }>` matching SPEC §6.5
  - [ ] Function queries `tree_nodes` for the given hypothesis and all its evidence children (by `parent_id`)
  - [ ] Sends evidence findings to Sonnet with a structured prompt; parses a JSON response for `confidence` (0–1), `evidenceStrength` (integer), `rationale` (string)
  - [ ] Updates the hypothesis node in DB: `confidence`, `evidence_strength`, `content.rationale`, `status='complete'`
  - [ ] When called with stub evidence nodes (manually inserted `EvidenceContent` rows), returns a valid confidence score
  - [ ] Output is deterministic enough that re-running on the same evidence produces a score within ±0.05 (achieved via low temperature or JSON schema enforcement)
- **Complexity**: Medium
- **Dependencies**: STORY-016, STORY-005
- **Notes**: Use a JSON schema output format (Sonnet structured output) to ensure `confidence` is always a number 0–1 and the response is parseable. Low temperature (0.2) for reproducibility. The prompt must reference the non-negotiable: "you are evaluating whether the evidence supports or refutes the hypothesis claim."

---

### STORY-018: Confidence Rollup (`agents/rollup.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/rollup.ts` to implement `rollupConfidence()` as a deterministic (no LLM) function that propagates confidence scores up the tree using SPEC §6.6's rules: weighted average for sub-hypothesis → hypothesis, weighted product (AND-aggregation) for hypothesis → decision, with weakest-link tracking.
- **Acceptance Criteria**:
  - [ ] `agents/rollup.ts` exports `function rollupConfidence(tree: TreeNode[], weights: Record<string, number>): TreeNode[]`
  - [ ] Sub-hypothesis → hypothesis: weighted average of child sub-hypothesis `confidence` values using slot weights
  - [ ] Hypothesis → decision: weighted product using case-level `weights` (marketSize 0.25, etc.) — this is AND-aggregation per SPEC §6.6
  - [ ] `weakestLinkNodeId` in the decision node's `content` is set to the hypothesis with the lowest weighted confidence contribution
  - [ ] Function returns the updated tree array with all confidence values filled
  - [ ] Unit test (or inline assertions): given manually set sub-hypothesis confidences for H1's three children, the H1 confidence matches the expected weighted average to 4 decimal places
  - [ ] Handles missing/null confidence values gracefully (treats them as 0.5 with a console warning)
- **Complexity**: Medium
- **Dependencies**: STORY-016, STORY-004
- **Notes**: This is pure math — no LLM. Write it as a pure function that takes the tree array and weights and returns a new array. Easy to unit-test. The "weakest link" is the single most important output for the demo decision card (acceptance criterion #4).

---

### STORY-019: Master Decision Agent (`agents/decision.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/decision.ts` to implement `decide()` as an Opus LLM call that reads the rolled-up hypothesis confidences, optionally merges in a Tier 2 result, and produces a typed `DecisionContent` with a final recommendation, reasoning, weakest-link callout, and per-threshold pass/fail.
- **Acceptance Criteria**:
  - [ ] `agents/decision.ts` exports `async function decide(caseId: string): Promise<DecisionContent>` matching SPEC §6.7
  - [ ] Reads all top-level hypothesis nodes for the case (type='hypothesis', parent=decision node) with their `confidence` and `weight`
  - [ ] Sends to Opus with a structured prompt; parses a JSON response for `finalDecision`, `reasoning`, `weakestLinkNodeId`, `thresholdsMet`
  - [ ] `thresholdsMet` uses the thresholds from `cases/abb-rack-pdu.yaml`: `minRevenue`, `timeYears`, `irrHurdle`, `internalDevMaxYears`
  - [ ] Updates the decision node in DB: `content`, `status='complete'`
  - [ ] With stub evidence (all hypothesis confidences ~0.7), the function returns a decision that says something in the direction of "Pursue rack PDU" — not a random hallucination
  - [ ] JSON schema enforcement on the Opus response to guarantee parseable output
  - [ ] **Tier 2 conditional (Q6)**: If rolled-up Tier 1 weighted confidence > 0.6, calls `evaluateTier2()` (STORY-019b) and merges its result into `finalDecision` text — e.g., "Pursue rack PDU via acquisition". If ≤ 0.6, `finalDecision` is "Do not pursue rack PDU" and Tier 2 is skipped (no Tier 2 evaluator call, no Tier 2 nodes written)
- **Complexity**: Medium
- **Dependencies**: STORY-018, STORY-005, STORY-019b
- **Notes**: Opus is the most expensive model; the prompt must be tight. Use structured output / tool-use JSON to enforce the `DecisionContent` shape. The `weakestLinkNodeId` from Opus should agree with (or defer to) the one computed by `rollupConfidence` — pass it in context to Opus so it can reference it rather than re-derive it.

---

### STORY-019b: Tier 2 Build/Buy/Partner Evaluator (`agents/tier2-evaluator.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/tier2-evaluator.ts` to score Build vs Buy vs Partner against the five SPEC §8 criteria (speed, control, capability fit, capital, risk) and recommend a winner, so that the Master Decision can include a mode recommendation when Tier 1 confidence clears the 0.6 threshold.
- **Acceptance Criteria**:
  - [ ] `agents/tier2-evaluator.ts` exports `async function evaluateTier2(caseId: string): Promise<Tier2Result>` where `Tier2Result = { recommendedOption: 'build' | 'buy' | 'partner'; scores: Record<'build'|'buy'|'partner', Record<'speed'|'control'|'capability_fit'|'capital'|'risk', number>>; rationale: string; }`
  - [ ] Sonnet is given: the case context, the rolled-up Tier 1 hypothesis confidences (signals which dimensions are strong/weak), and the five Tier 2 criteria
  - [ ] Returns scores 0–1 per option×criterion, picks `recommendedOption` as the option with the highest sum (ties broken by lowest risk)
  - [ ] Writes one `tree_nodes` row per option (type='hypothesis', parent=decision node, label='Build'|'Buy'|'Partner', `content.claim`=option recommendation rationale) and one sub-hypothesis row per criterion under each option (15 total Tier 2 nodes)
  - [ ] Scenario-id is left null (Tier 2 is part of baseline run)
  - [ ] **Conditional invocation**: callers (STORY-019) only invoke this when Tier 1 weighted confidence > 0.6 — the function itself does not check; it always runs when called
  - [ ] On the ABB case with stub Tier 1 confidences ~0.7, `recommendedOption` is one of the three valid values (the SPEC notes ABB's deck pre-concludes acquisition, but Victor must reach this independently)
- **Complexity**: Medium
- **Dependencies**: STORY-018, STORY-005, STORY-016
- **Notes**: Tier 2 is comparative-scoring not evidence-gathering — there is no web/doc evidence agent fanout for Tier 2 in v1. The scoring uses Tier 1 evidence as input signal via the prompt. JSON schema enforcement on the Sonnet output. Use Sonnet not Opus — Opus is reserved for the final synthesis in STORY-019.

---

### STORY-020: Run Orchestrator — pipeline wiring (`agents/orchestrator.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/orchestrator.ts` to implement `runCase()` as the pipeline coordinator that calls agents in sequence (parseBrief → bindFramework → buildTree → [evidence fanout placeholder] → evaluateHypothesis × N → rollupConfidence → decide) and writes `runs` table status updates throughout, so that the end-to-end pipeline is callable from a single function.
- **Acceptance Criteria**:
  - [ ] `agents/orchestrator.ts` exports `async function runCase(caseId: string, scenarioId?: string): Promise<RunResult>`
  - [ ] Creates a `runs` row with `status='running'` at start; updates to `status='complete'` or `status='failed'` at end
  - [ ] Calls parseBrief → bindFramework → buildTree in sequence
  - [ ] After tree build, calls `evaluateHypothesis` for each sub-hypothesis node in the tree (using stub evidence at this stage — real evidence fanout added in EPIC-004)
  - [ ] After all evaluations, calls `rollupConfidence`, then `decide`
  - [ ] Uses `Promise.allSettled` for the evidence fanout (SPEC §12 failure mode prevention): a single agent failure does not crash the run; failed nodes get `status='failed'` and confidence 0
  - [ ] A call to `runCase('abb-rack-pdu-case-id')` completes without unhandled errors and leaves a `runs` row with `status='complete'`
  - [ ] Run duration is logged to console on completion
- **Complexity**: Large
- **Dependencies**: STORY-014, STORY-015, STORY-016, STORY-017, STORY-018, STORY-019
- **Notes**: This is the biggest story in the pipeline epic. The evidence fanout placeholder means: for each leaf sub-hypothesis node, create one stub `EvidenceContent` tree node before calling `evaluateHypothesis`. Real web and doc evidence agents are added in EPIC-004 by replacing this stub. The `Promise.allSettled` pattern is required by SPEC §12 non-negotiable.

---

### STORY-021: Runs API route and pipeline trigger (`app/api/runs/[id]/route.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need a `POST /api/runs` endpoint to create a new run for a case and a `GET /api/runs/[id]` endpoint to poll run status, so that the UI can trigger and monitor pipeline execution.
- **Acceptance Criteria**:
  - [ ] `POST /api/cases/[caseId]/runs` (or `POST /api/runs` with body `{ caseId }`) creates a `runs` row and calls `runCase(caseId)` asynchronously (fire-and-forget from the HTTP response)
  - [ ] Returns `{ runId }` immediately with HTTP 202
  - [ ] `GET /api/runs/[id]` returns the current run row: `{ status, startedAt, completedAt, error }`
  - [ ] If the run is `complete`, also returns the decision node's `content` (final decision text)
  - [ ] Handles `runId` not found with HTTP 404
  - [ ] A `curl -X POST` call triggers the pipeline and a subsequent `GET` poll shows `status='complete'` within 60 seconds (stub pipeline, no real LLM calls yet if llm-client is mocked)
- **Complexity**: Medium
- **Dependencies**: STORY-020, STORY-002
- **Notes**: The fire-and-forget pattern (HTTP 202, async `runCase`) is correct for a 14-day demo. For v1, no streaming or WebSocket needed — the UI polls. Route file paths should match SPEC §9 (`app/api/runs/[id]/route.ts`). Add `app/api/cases/route.ts` as a stub here too (returns the hardcoded ABB case).

---

## EPIC-004: Evidence Agents — Web and Doc (AV-03)

**User Value**: For each leaf sub-hypothesis, real evidence is gathered from Tavily web search and pgvector doc retrieval, written as evidence nodes with source linkage. The H1 branch in particular surfaces the OMDIA chart. After this epic, `runCase()` produces a fully evidence-backed tree.

**Dependencies**: EPIC-002 (doc retrieval needs ingested sources), EPIC-003 (needs `runCase` orchestrator, tree nodes, `lib/llm-client.ts`, `lib/search.ts`)

**Estimated Total Effort**: 4–6 days

**Maps to SPEC**: §6.4, acceptance criterion #10

---

### STORY-022: Web search evidence agent (`agents/evidence/web-search.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/evidence/web-search.ts` to implement the `web` mode of `gatherEvidence()` so that for a given sub-hypothesis, Tavily is queried, results are scored, and 3–5 evidence nodes are written to the DB with source linkage.
- **Acceptance Criteria**:
  - [ ] `agents/evidence/web-search.ts` exports `async function gatherWebEvidence(hypothesis: TreeNode, caseContext: CaseContext): Promise<EvidenceNode[]>`
  - [ ] Constructs a Tavily query from the hypothesis `label` and case context (substitutions applied); e.g., "ABB rack PDU accessible market size $100M threshold"
  - [ ] Calls `lib/search.ts`; for each result, calls Mistral (via `lib/llm-client.ts`) to extract a `finding`, `supports` (for/against/mixed), and `strength` (weak/moderate/strong)
  - [ ] Each evidence item is written as a `tree_nodes` row with `type='evidence'`, `parent_id=hypothesis.id`, and the correct `EvidenceContent`
  - [ ] Each evidence item creates a `sources` row (type='web', uri=URL, title, content_extract=snippet) and an `evidence_sources` linkage row with `quote`
  - [ ] Running for SH1.1 ("TAM-SAM-SOM bridge supports $100M") produces at least 2 evidence nodes
- **Complexity**: Medium
- **Dependencies**: STORY-006, STORY-005, STORY-003, STORY-016
- **Notes**: The Mistral call is cheap and parallelizable per SPEC §6.4. Use low temperature (0.1). The `sourceQuote` in `EvidenceContent` should be the relevant excerpt from the Tavily result, not the full snippet. Enforce JSON output from Mistral.

---

### STORY-023: Doc retrieval evidence agent (`agents/evidence/doc-retrieval.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/evidence/doc-retrieval.ts` to implement the `doc` mode of `gatherEvidence()` so that for a given sub-hypothesis, pgvector retrieval surfaces the most relevant chunks from the ABB PDFs and each chunk becomes an evidence node with page-number citation.
- **Acceptance Criteria**:
  - [ ] `agents/evidence/doc-retrieval.ts` exports `async function gatherDocEvidence(hypothesis: TreeNode, caseContext: CaseContext): Promise<EvidenceNode[]>`
  - [ ] Calls `retrieveEvidence(query, caseId, topK=5)` from `lib/ingest.ts` / `lib/retrieval.ts`
  - [ ] For each returned chunk, calls Gemini (via `lib/llm-client.ts`) to extract `finding`, `supports`, and `strength` relative to the hypothesis claim
  - [ ] Writes evidence nodes to `tree_nodes` and creates `evidence_sources` rows with `quote` and `page_number` populated from chunk metadata
  - [ ] For SH1.2 ("Growth trajectory is favourable"), the function returns an evidence node whose `finding` includes "10.4% CAGR" sourced from `abb-rack-pdu-deck.pdf` page 8
  - [ ] Evidence nodes from doc retrieval have `source.type='pdf'` and `sources.metadata.stake` propagated from the original ingest metadata
- **Complexity**: Medium
- **Dependencies**: STORY-013, STORY-022, STORY-005
- **Notes**: This is the story where acceptance criterion #10 is satisfied. If the OMDIA chunk is not being retrieved (verified in STORY-012), the issue is in the ingest or embedding step — fix it there, not here. The Gemini call uses the long-context capability for multi-chunk analysis if needed, but for v1 a per-chunk call is simpler.

---

### STORY-024: Evidence orchestration fanout — replace stub in `orchestrator.ts`

- **Type**: Technical Story
- **Statement**: As a developer, I need the orchestrator's evidence step to call both `gatherWebEvidence` and `gatherDocEvidence` in parallel for each leaf sub-hypothesis using `Promise.allSettled`, replacing the stub evidence nodes created in STORY-020.
- **Acceptance Criteria**:
  - [ ] `agents/orchestrator.ts` is updated: the stub evidence creation is replaced by `Promise.allSettled([gatherWebEvidence(node, ctx), gatherDocEvidence(node, ctx)])` for each leaf node
  - [ ] All 11 sub-hypothesis leaves are processed in parallel (outer `Promise.allSettled` across all leaves)
  - [ ] If one evidence agent fails for a leaf, that leaf gets `status='failed'` and confidence defaults to 0; the run continues for all other leaves
  - [ ] Total evidence nodes written to DB after a full run: at least 22 (2 per leaf minimum, likely 30–45)
  - [ ] `runs` table `status` transitions are correct: `running` during fanout, `complete` after decision
  - [ ] A full end-to-end `runCase` call completes within 10 minutes using real LLM calls (acceptable for demo; pre-caching handles Day 14)
- **Complexity**: Medium
- **Dependencies**: STORY-022, STORY-023, STORY-020
- **Notes**: The nested `Promise.allSettled` pattern: outer over leaves, inner over [web, doc] per leaf. The total parallelism is 11 × 2 = 22 concurrent LLM+search calls — watch for rate limits. Consider batching in groups of 5 if Tavily or the LLM gateway has low rate limits.

---

### STORY-025: Question generator agent stub (`agents/evidence/question-generator.ts`)

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/evidence/question-generator.ts` to exist as a stub (returning an empty array) so that the evidence agent interface is complete and the HITL path can be wired in EPIC-006 without modifying the evidence agents.
- **Acceptance Criteria**:
  - [ ] File exists at `agents/evidence/question-generator.ts`
  - [ ] Exports `async function generateQuestions(hypothesis: TreeNode, evidenceNodes: EvidenceNode[]): Promise<QuestionNode[]>`
  - [ ] Always returns an empty array in the stub implementation
  - [ ] A comment in the file explains the intended v1 behavior: "fires only if web+doc evidence strength < threshold"
  - [ ] TypeScript compiles without errors
- **Complexity**: Small
- **Dependencies**: STORY-022
- **Notes**: Per Open Question Q3 recommendation (Option C — skip HITL for v1), this stub is the entire HITL implementation for the demo. If Q3 is answered in favor of full HITL, this story becomes a real implementation in EPIC-006.

---

## EPIC-005: UI — Kanban Overview, Drill-Down, and Source Modals (AV-05 + AV-06)

**User Value**: The full demo click path is navigable in the browser: a user opens the ABB case, triggers a run (or loads the pre-cached run), sees the Kanban board of hypotheses with confidence meters, drills into any hypothesis to see sub-hypotheses, clicks a sub-hypothesis to see evidence, and clicks evidence to open a source modal with the URL or PDF page citation. This epic is where acceptance criteria #1–8 and #10 all become testable together.

**Dependencies**: EPIC-003 (needs the runs API, decision node, hypothesis nodes, and confidence rollup data), EPIC-004 (needs evidence nodes and source linkage for acceptance criteria #6, #7, #10)

**Estimated Total Effort**: 5–7 days

**Maps to SPEC**: §3 (UI architecture), §9 (components), acceptance criteria #1–8, #10

---

### STORY-026: TanStack Query and Zustand setup

- **Type**: Technical Story
- **Statement**: As a developer, I need TanStack Query (for server state / polling) and Zustand (for minimal client state) installed and configured so that all UI components can fetch and cache run data without prop-drilling.
- **Acceptance Criteria**:
  - [ ] `@tanstack/react-query` and `zustand` are in `package.json`
  - [ ] A `QueryClientProvider` wraps the root layout in `app/layout.tsx`
  - [ ] A Zustand store at `lib/store.ts` (or `app/store.ts`) exports at minimum `selectedRunId: string | null` and `setSelectedRunId(id: string): void`
  - [ ] `npm run build` passes
- **Complexity**: Small
- **Dependencies**: STORY-001
- **Notes**: Keep the Zustand store minimal — TanStack Query owns server data. Zustand is only for client navigation state (which run is selected, which node is expanded).

---

### STORY-027: React Flow install and base tree canvas

- **Type**: Technical Story
- **Statement**: As a developer, I need React Flow installed and a base `<TreeCanvas>` component rendering a placeholder node graph so that subsequent stories can render real tree nodes in the correct layout.
- **Acceptance Criteria**:
  - [ ] `reactflow` (or `@xyflow/react`) is in `package.json`
  - [ ] `components/TreeCanvas.tsx` renders a React Flow canvas with at least one placeholder node
  - [ ] The canvas is embedded in `/case/[id]` page and visible in the browser at the correct route
  - [ ] The default React Flow layout is horizontal (left-to-right) or top-down — confirm with Harry which orientation matches the demo visual intent
  - [ ] `npm run build` passes
- **Complexity**: Small
- **Dependencies**: STORY-026, STORY-009
- **Notes**: The SPEC mentions both "Kanban view" and "tree expansion" as separate views. For v1, the Kanban overview is the default; the tree is accessed by clicking into a hypothesis. React Flow can power both with different node configurations.

---

### STORY-028: Case page — run trigger and status polling

- **Type**: User Story
- **Statement**: As a user, I want to open the ABB Rack PDU case page and click "Run" to trigger the analysis pipeline, then see a live progress indicator while the run is in progress, so that I know the system is working.
- **Acceptance Criteria**:
  - [ ] `/case/[id]` page loads the case from the InsForge DB (or hardcoded for now) and shows the case title and question
  - [ ] A "Run" button calls `POST /api/cases/[id]/runs` and receives a `runId`
  - [ ] The page polls `GET /api/runs/[runId]` every 3 seconds using TanStack Query
  - [ ] While `status='running'`, a visible progress indicator (spinner or status text "Gathering evidence...") is shown
  - [ ] When `status='complete'`, the progress indicator is replaced by the tree view
  - [ ] When `status='failed'`, an error message with the run's `error` field is shown
  - [ ] If a pre-cached complete run exists for this case, the "Run" button shows "View Results" instead and navigates directly to the tree view (supports Day 14 pre-cached demo — per Open Question Q2 Option A)
- **Complexity**: Medium
- **Dependencies**: STORY-021, STORY-027
- **Notes**: The "pre-cached run" UX (checking for an existing complete run on page load) is important for the Day 14 demo. It should be a simple `GET /api/cases/[id]/runs/latest` that returns the most recent complete run if one exists.

---

### STORY-029: Kanban board component (`components/KanbanBoard.tsx`)

- **Type**: User Story
- **Statement**: As a user, I want to see all five hypotheses displayed as Kanban-style cards with confidence meters so that I can understand at a glance which hypotheses are strong and which are the weakest link.
- **Acceptance Criteria**:
  - [ ] `components/KanbanBoard.tsx` accepts a `runId` and fetches the top-level hypothesis nodes from `GET /api/runs/[id]/nodes` (or equivalent)
  - [ ] Each hypothesis is a card showing: label, confidence score as a percentage, weight, and `status` (pending / running / complete / failed)
  - [ ] `components/ConfidenceMeter.tsx` renders a visual bar or arc matching the confidence value; green above 0.7, amber 0.4–0.7, red below 0.4
  - [ ] The decision card (root node) is visually prominent: shows `finalDecision` text, overall confidence, and the weakest-link hypothesis name
  - [ ] Clicking a hypothesis card navigates to or opens the drill-down view for that hypothesis (connection to STORY-030)
  - [ ] The weakest-link hypothesis is visually distinguished (e.g., a red border or a "weakest link" badge)
- **Complexity**: Medium
- **Dependencies**: STORY-021, STORY-028, STORY-026
- **Notes**: The Kanban view is the first thing Daniel sees in the demo. It needs to look intentional — not a raw data dump. The weakest-link callout is acceptance criterion #4 and a demo talking point. Invest in this component's visual quality.

---

### STORY-030: Hypothesis drill-down view — sub-hypothesis tree

- **Type**: User Story
- **Statement**: As a user, I want to click on a hypothesis card and see a tree view of its sub-hypotheses with their individual confidence scores so that I can drill into how the hypothesis conclusion was reached.
- **Acceptance Criteria**:
  - [ ] Clicking a hypothesis card on the Kanban board opens a drill-down view (new route `/case/[id]/hypothesis/[nodeId]` or an inline expand)
  - [ ] The drill-down view shows the hypothesis claim as a header
  - [ ] All sub-hypothesis children are shown as nodes with label, confidence score, and evidence count
  - [ ] Each sub-hypothesis is clickable and navigates to the evidence view (STORY-031)
  - [ ] A "back to overview" breadcrumb or button returns to the Kanban board
  - [ ] Acceptance criterion #5: "Clicking any hypothesis card expands it into a tree view showing sub-hypotheses with their own confidence scores" — verified
- **Complexity**: Medium
- **Dependencies**: STORY-029
- **Notes**: Use React Flow for the sub-hypothesis tree layout. Nodes are sub-hypotheses; edges represent the parent-child relationship. This is the second step in the demo drill-down path.

---

### STORY-031: Evidence list view for sub-hypothesis

- **Type**: User Story
- **Statement**: As a user, I want to click on a sub-hypothesis and see a list of evidence nodes backing it (supporting, against, and mixed), so that I can understand what data was used to reach the confidence score.
- **Acceptance Criteria**:
  - [ ] Clicking a sub-hypothesis node opens an evidence list panel or route
  - [ ] Each evidence node shows: `finding` text, `supports` badge (green "For" / red "Against" / grey "Mixed"), `strength` indicator, and source attribution (title or domain)
  - [ ] Evidence items from doc retrieval show the PDF title and page number
  - [ ] Evidence items from web search show the source domain
  - [ ] Clicking any evidence item opens the source modal (STORY-032)
  - [ ] Acceptance criterion #6: "Clicking any sub-hypothesis shows the evidence backing it" — verified
- **Complexity**: Medium
- **Dependencies**: STORY-030
- **Notes**: An API endpoint `GET /api/runs/[id]/nodes/[nodeId]/evidence` (or similar) should return the evidence children and their source linkages in one query. Avoid N+1 queries — join `evidence_sources` and `sources` in the same query.

---

### STORY-032: Source modal (`components/EvidenceModal.tsx`, `components/SourceViewer.tsx`)

- **Type**: User Story
- **Statement**: As a user, I want to click on a piece of evidence and see a modal showing the original source — the URL and quoted passage for web sources, the PDF title and page number for document sources — so that every claim has auditable provenance.
- **Acceptance Criteria**:
  - [ ] Clicking an evidence item opens `components/EvidenceModal.tsx`
  - [ ] For web sources: shows the source URL (as a clickable link), the `quote` from `evidence_sources`, and the `finding` text
  - [ ] For PDF sources: shows the document title, page number, and the quoted passage from the chunk
  - [ ] Source data is loaded from the DB at run time (not fetched live on click — per SPEC §12 failure mode prevention: "cache resolved sources at run time")
  - [ ] The modal is closeable via a button or Escape key
  - [ ] Acceptance criterion #7: "Clicking any evidence opens a modal with the actual source" — verified
  - [ ] For the OMDIA evidence node under H1: the modal shows "abb-rack-pdu-deck.pdf", page 8, and the quoted passage containing "10.4% CAGR"
  - [ ] Acceptance criterion #10: the OMDIA chart evidence is visible in the modal with the CAGR figure called out
- **Complexity**: Medium
- **Dependencies**: STORY-031
- **Notes**: The "cache resolved sources at run time" requirement means the source data should be pre-loaded with the evidence nodes when the run completes, not fetched fresh when the modal opens. A single `GET /api/runs/[id]/nodes/[nodeId]/evidence` endpoint returning evidence + source data together satisfies this. No live PDF rendering needed — page number + quote is sufficient for v1.

---

### STORY-033: `app/api/nodes` — tree data API routes

- **Type**: Technical Story
- **Statement**: As a developer, I need API routes that serve tree node data hierarchically so that the UI components (Kanban, drill-down, evidence list) can load their data without duplicating DB queries.
- **Acceptance Criteria**:
  - [ ] `GET /api/runs/[id]/nodes` returns all tree nodes for a run, grouped by type, with confidence and status
  - [ ] `GET /api/runs/[id]/nodes/[nodeId]` returns a single node with its direct children
  - [ ] `GET /api/runs/[id]/nodes/[nodeId]/evidence` returns a node's evidence children, each including its full `evidence_sources` + `sources` join (title, uri, quote, page_number, stake)
  - [ ] All responses are typed and match `lib/schema.ts` interfaces
  - [ ] Queries use `case_id` filtering to prevent cross-case data leakage
  - [ ] Response times under 500ms for the ABB case (which has ~50–60 nodes)
- **Complexity**: Medium
- **Dependencies**: STORY-021, STORY-004
- **Notes**: These routes are the backend contract for the entire UI epic. Define the response shapes before building STORY-029 through STORY-032, or the UI stories will need rework. Consider making STORY-033 a prerequisite for STORY-029 (or at minimum, stub the routes with hardcoded data first).

---

## EPIC-006: HITL Question Batching (AV-07a) — **DROPPED PER Q3**

**Status**: Cut for v1. Do not build. STORY-025 (question-generator stub) in EPIC-004 is the entire HITL surface in the codebase. Stories below preserved for v2 reference only.

**Dependencies**: EPIC-004 (question generator agent, evidence fanout), EPIC-005 (UI must show question list)

**Demo-criticality**: DROPPED — not in v1 demo per Harry's decision 2026-05-05.

**Estimated Total Effort**: 3–4 days

**Maps to SPEC**: §6.4 (question mode), §5.1 (user_questions table), acceptance criteria implied by SPEC §3

---

### STORY-034: Question generator — real implementation

- **Type**: Technical Story
- **Statement**: As a developer, I need `agents/evidence/question-generator.ts` to be implemented as a real Sonnet call that generates targeted questions when web + doc evidence strength is below a threshold, producing `user_questions` rows that can pause the run.
- **Acceptance Criteria**:
  - [ ] Replaces the stub from STORY-025
  - [ ] Fires only if the combined `strength` of web + doc evidence nodes for a leaf is 'weak' (no 'strong' or 'moderate' nodes found)
  - [ ] Produces 1–3 questions per low-confidence leaf using Sonnet
  - [ ] Writes rows to `user_questions` with `question_type`, `affects_node_ids`, and `needed_because`
  - [ ] Updates run `status='awaiting_input'` after writing questions
- **Complexity**: Medium
- **Dependencies**: STORY-025, STORY-024
- **Notes**: Threshold for "low strength" = all evidence nodes for a leaf have `strength='weak'`. Only trigger if at least 2 attempts (web + doc) both returned weak evidence.

---

### STORY-035: HITL UI — question batch display (`components/QuestionList.tsx`)

- **Type**: User Story
- **Statement**: As a user, I want to see the questions Victor has for me when a run is awaiting input, answer them in a simple form, and have the run resume with my answers.
- **Acceptance Criteria**:
  - [ ] When `run.status='awaiting_input'`, the case page shows a `components/QuestionList.tsx` panel above the tree
  - [ ] Each question shows its text, type (yes/no toggle or open text field), and `needed_because` context
  - [ ] Submitting answers calls `PATCH /api/questions/[id]` with the answer
  - [ ] After all questions answered, a "Submit Answers & Resume" button calls a resume endpoint
  - [ ] The run transitions back to `status='running'` and continues to the evaluator step
- **Complexity**: Large
- **Dependencies**: STORY-034, STORY-033
- **Notes**: The resume logic in the orchestrator needs to re-trigger `evaluateHypothesis` for the affected nodes after answers are recorded.

---

## EPIC-007: Demo Preparation (AV-08)

**User Value**: The Day 14 demo runs flawlessly. The pre-cached run is ready, the click path is scripted and tested, all known failure modes are handled gracefully, and there is a fallback plan.

**Dependencies**: EPIC-005 (full UI must be complete), EPIC-004 (real evidence pipeline must be complete)

**Demo-criticality**: DEMO-CRITICAL — this is the final gate.

**Estimated Total Effort**: 2–3 days

**Maps to SPEC**: §12 (all acceptance criteria), §2 (pre-cached run)

---

### STORY-036: End-to-end pipeline run against real ABB documents

- **Type**: Technical Story
- **Statement**: As a developer, I need to execute a full `runCase('abb-rack-pdu')` with real LLM calls, Tavily search, and doc retrieval against the ingested ABB PDFs, verify all 10 acceptance criteria manually, and fix any failures found.
- **Acceptance Criteria**:
  - [ ] `runCase` completes with `status='complete'` using real APIs (not stubs)
  - [ ] 30–45 evidence nodes written to DB
  - [ ] All 5 hypotheses have confidence scores (not null, not 0)
  - [ ] Decision node has `finalDecision`, `weakestLinkNodeId`, `thresholdsMet` all populated
  - [ ] Acceptance criterion #9 manually verified: pick H1, compute expected confidence from sub-hypothesis scores × weights, confirm it matches the DB value to 2 decimal places
  - [ ] Acceptance criterion #10 verified: query `sources` + `evidence_sources` for "10.4% CAGR" — confirms a row exists under H1 branch
  - [ ] All errors logged during the run are reviewed and resolved
  - [ ] Total run time measured and documented
- **Complexity**: Large
- **Dependencies**: STORY-024, STORY-032, STORY-023
- **Notes**: This story will likely surface bugs. Budget a full day. Run it first in development, then on the Vercel deployment. Document any flaky LLM responses and add retry logic if needed.

---

### STORY-037: Pre-cached run setup and "View Results" flow

- **Type**: Technical Story
- **Statement**: As a developer, I need the demo run result to be pre-cached in InsForge and the UI to detect and surface it immediately on page load, so that clicking "View Results" on demo day shows the tree in under 2 seconds without any live agent calls.
- **Acceptance Criteria**:
  - [ ] The complete run from STORY-036 is the pre-cached run; its `runs.id` is noted
  - [ ] `GET /api/cases/[id]/runs/latest` returns the most recent `status='complete'` run for the case
  - [ ] The case page checks for an existing complete run on load; if found, shows "View Results" button instead of "Run"
  - [ ] Clicking "View Results" navigates directly to the Kanban board view with all data loaded from the pre-cached run
  - [ ] Time from clicking "View Results" to fully rendered Kanban board: under 2 seconds
  - [ ] If the pre-cached run is deleted or fails to load, the page gracefully falls back to the "Run" button
- **Complexity**: Medium
- **Dependencies**: STORY-036, STORY-028
- **Notes**: The "View Results" vs "Run" bifurcation is the key UX pattern for the demo. On demo day, "Run" will never be clicked — the cached result is everything. But the "Run" path must still work as a backstop.

---

### STORY-038: Click path rehearsal and error hardening

- **Type**: Technical Story
- **Statement**: As a developer, I need to walk the full demo click path (Decision → Hypothesis → Sub-hypothesis → Evidence → Source) end-to-end three times without errors, fix any failures found, and confirm all 10 acceptance criteria pass on the deployed Vercel URL.
- **Acceptance Criteria**:
  - [ ] The drill-down click path (SPEC §12 AC#8) is navigated 3 times in a row without any console errors, blank screens, or unhandled exceptions
  - [ ] All 10 acceptance criteria from SPEC §12 verified by Harry on the production Vercel URL
  - [ ] Source modal loads within 1 second for all evidence nodes (data pre-loaded, no live fetching)
  - [ ] The OMDIA evidence under H1 shows page 8 citation and "10.4% CAGR" in the modal (AC#10)
  - [ ] Confidence meters display correctly (not NaN, not 0 for all nodes)
  - [ ] Weakest-link hypothesis is visually called out on the decision card (AC#4)
  - [ ] No broken links, no 404 routes in the click path
- **Complexity**: Medium
- **Dependencies**: STORY-037
- **Notes**: This story is the final acceptance test. If it fails, STORY-036 debugging steps repeat. Block time on Day 12–13 specifically for this story.

---

### STORY-039: Demo script and fallback plan

- **Type**: Technical Story
- **Statement**: As a developer, I need a written demo script (what to click, what to say at each step) and a documented fallback plan (what to do if the Vercel deployment fails), so that the Day 14 demo proceeds confidently.
- **Acceptance Criteria**:
  - [ ] A `DEMO.md` file exists at the repo root with a step-by-step click script mapping each action to a talking point
  - [ ] The script explicitly calls out the OMDIA/10.4% CAGR moment and the weakest-link callout as demo highlights
  - [ ] A "fallback" section describes the contingency: screenshots of the working app, or a local `npm run dev` if Vercel is unavailable
  - [ ] Harry has reviewed and approved the script before Day 14
- **Complexity**: Small
- **Dependencies**: STORY-038
- **Notes**: This is a real deliverable, not a formality. A demo to a CEO without a script is a risk. The script should be rehearsed at least twice.

---

## EPIC-008: Multi-Model Routing (AV-07b) [DROPPABLE — First to Cut]

**User Value**: Evidence agents use different models (Mistral for web search, Gemini for doc retrieval) per SPEC §6.4. The LLM client routes by agent role. This makes the architecture diagram on the SPEC cover page accurate for the demo and demonstrates multi-model orchestration.

**Dependencies**: EPIC-004 (evidence agents must be working first), EPIC-003 (`lib/llm-client.ts` MODEL_MAP in place)

**Demo-criticality**: DROPPABLE — first to cut per SPEC §2. If EPIC-001 through EPIC-007 are not complete by Day 10, skip this epic entirely. Sonnet alone can handle all roles for the demo.

**Estimated Total Effort**: 2–3 days

**Maps to SPEC**: §6.4 (model assignment), §2 (cut order), §4 (LLM access)

---

### STORY-040: MODEL_MAP wiring — Mistral for web, Gemini for doc

- **Type**: Technical Story
- **Statement**: As a developer, I need `lib/llm-client.ts` MODEL_MAP updated so that `gatherWebEvidence` uses Mistral and `gatherDocEvidence` uses Gemini, confirming multi-model routing works in a real run.
- **Acceptance Criteria**:
  - [ ] `MODEL_MAP['evidence-web']` resolves to `'mistral-large'` (or the correct Mistral model slug on the chosen gateway)
  - [ ] `MODEL_MAP['evidence-doc']` resolves to `'gemini-pro'` (or correct Gemini slug)
  - [ ] `MODEL_MAP['evaluator']` remains Sonnet; `MODEL_MAP['decision']` remains Opus
  - [ ] A full run (`runCase`) logs which model was used for each evidence node, and the logs confirm Mistral and Gemini are being invoked
  - [ ] `model_used` column in `tree_nodes` is populated for evidence nodes
  - [ ] Run completes successfully (no model availability errors)
- **Complexity**: Medium
- **Dependencies**: STORY-005, STORY-024
- **Notes**: If the chosen gateway (Open Question Q1) does not support Mistral or Gemini, this story is blocked. Confirm gateway availability for these models before starting. If unavailable, this epic is dropped and Sonnet is used for all roles.

---

### STORY-041: Model attribution in UI

- **Type**: User Story
- **Statement**: As a user (or as Harry demoing), I want to see which model produced each evidence node so that the multi-model architecture is visible in the UI and becomes a demo talking point.
- **Acceptance Criteria**:
  - [ ] The evidence list view (STORY-031) shows a small model badge on each evidence item (e.g., "Mistral" for web evidence, "Gemini" for doc evidence)
  - [ ] The badge pulls from `tree_nodes.model_used`
  - [ ] On the demo, the architecture diagram slide (if shown) is corroborated by what's visible in the UI
- **Complexity**: Small
- **Dependencies**: STORY-040, STORY-031
- **Notes**: This is a small cosmetic addition but has outsized demo value — it makes the multi-model claim visible and auditable.

---

## Recommended Execution Order

The goal is to make the **drill-down click path testable end-to-end as early as possible** — specifically, the sequence Decision → Hypothesis → Sub-hypothesis → Evidence → Source should be navigable with real data by Day 7–8 (mid-point), giving 6 days of polish, bug-fixing, and pre-caching before Day 14.

### Week 1 (Days 1–7): Vertical Slice + Full Pipeline

**Days 1–2: Foundation (EPIC-001)**

Run these stories in parallel where possible:

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-001: Next.js init | Gate for everything |
| 2 | STORY-002: InsForge SDK + `lib/db.ts` | Parallel with STORY-005, STORY-006 |
| 2 | STORY-005: `lib/llm-client.ts` | Parallel with STORY-002 — blocked on Q1 |
| 2 | STORY-006: Tavily `lib/search.ts` | Parallel with STORY-002 |
| 3 | STORY-003: Schema deployment | After STORY-002 |
| 3 | STORY-004: `lib/schema.ts` | After STORY-003 |
| 3 | STORY-007: YAML config files + registry | After STORY-004 |
| 4 | STORY-008: Env validation | After STORY-002, STORY-005 |
| 4 | STORY-009: Placeholder homepage | After STORY-001 |

**Days 2–4: Ingestion (EPIC-002) — parallel with EPIC-003 start**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-010: PDF extraction + chunking | Needs PDFs in `docs/` — verify Q4 |
| 2 | STORY-011: Embeddings + source storage | After STORY-010 |
| 3 | STORY-012: Ingest script + OMDIA verification | **Critical gate** — if OMDIA chunk not found, debug here |
| 4 | STORY-013: `retrieveEvidence()` function | After STORY-011 |

**Days 3–5: Pipeline Core (EPIC-003)**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-014: Brief Parser stub | Fast — start Day 3 |
| 1 | STORY-015: Framework Binder stub | Fast — same day as STORY-014 |
| 2 | STORY-016: Tree Builder | After STORY-015 |
| 3 | STORY-017: Hypothesis Evaluator | After STORY-016 |
| 3 | STORY-018: Confidence Rollup | After STORY-016 (parallel with STORY-017) |
| 4 | STORY-019: Master Decision Agent | After STORY-017, STORY-018 |
| 5 | STORY-020: Run Orchestrator (pipeline wiring) | After STORY-019 |
| 5 | STORY-021: Runs API routes | After STORY-020 |

**Days 5–7: Evidence Agents (EPIC-004)**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-022: Web search evidence agent | After STORY-006, STORY-016 |
| 1 | STORY-023: Doc retrieval evidence agent | After STORY-013, STORY-022 |
| 2 | STORY-025: Question generator stub | Small — do alongside STORY-022 |
| 3 | STORY-024: Evidence fanout in orchestrator | After STORY-022, STORY-023 |

**End of Day 7 checkpoint**: `runCase('abb-rack-pdu')` should complete with real evidence. Verify OMDIA chunk appears under H1.

### Week 2 (Days 7–13): UI + Polish + Demo Prep

**Days 7–10: UI (EPIC-005)**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-033: Tree data API routes | **First** — UI stories depend on this contract |
| 2 | STORY-026: TanStack Query + Zustand | Parallel with STORY-033 |
| 2 | STORY-027: React Flow base canvas | Parallel with STORY-033 |
| 3 | STORY-028: Run trigger + status polling | After STORY-026, STORY-021 |
| 4 | STORY-029: Kanban board + ConfidenceMeter | After STORY-028, STORY-033 |
| 4 | STORY-030: Hypothesis drill-down | After STORY-029 |
| 5 | STORY-031: Evidence list view | After STORY-030 |
| 6 | STORY-032: Source modal | After STORY-031 |

**End of Day 10 checkpoint**: Full drill-down click path navigable in the browser. All 10 acceptance criteria should be verifiable at this point (rough state, not polished).

**Days 10–11: Multi-Model (EPIC-008) — only if Day 10 checkpoint passed**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-040: MODEL_MAP wiring | Only if Q1 confirms gateway supports Mistral + Gemini |
| 2 | STORY-041: Model attribution in UI | After STORY-040 |

**Days 12–13: Demo Prep (EPIC-007)**

| Priority | Story | Note |
|----------|-------|------|
| 1 | STORY-036: Full pipeline run + AC verification | Budget a full day |
| 2 | STORY-037: Pre-cached run + "View Results" flow | After STORY-036 |
| 3 | STORY-038: Click path rehearsal + error hardening | After STORY-037 |
| 4 | STORY-039: Demo script + fallback plan | Final |

**Day 14: Demo**

---

## Risk & Dependency Summary

### Critical Path

The critical path runs: STORY-001 → STORY-002 → STORY-003 → STORY-004 → STORY-007 → STORY-016 → STORY-020 → STORY-021 → STORY-033 → STORY-029 → STORY-030 → STORY-031 → STORY-032

This is the backbone of the drill-down click path. Any delay in this chain delays the demo's pass/fail test.

Parallel acceleration is available: STORY-005 (LLM client), STORY-006 (Tavily), STORY-010 (PDF ingest), and STORY-026 (TanStack Query) can all run in parallel with different stories in the critical path.

### Demo-Critical Epics (Cannot Drop)

| Epic | Why Demo-Critical |
|------|-------------------|
| EPIC-001: Foundation | Every other epic depends on it |
| EPIC-002: Ingestion | OMDIA evidence (AC#10) requires real PDF ingest |
| EPIC-003: Pipeline Core | Confidence rollup (AC#9) and decision card (AC#4) require this |
| EPIC-004: Evidence Agents | Real evidence backing sub-hypotheses (AC#6, #10) requires this |
| EPIC-005: UI | The drill-down click path (AC#8) is entirely this epic |
| EPIC-007: Demo Prep | The demo does not happen without pre-caching and rehearsal |

### Droppable Epics (In Cut Order)

| Epic | Cut Order | Impact if Dropped |
|------|-----------|-------------------|
| EPIC-008: Multi-Model (AV-07b) | **First to cut** | All LLM calls use Sonnet only. Architecture diagram needs a footnote. MODEL_MAP still exists but routes everything to Sonnet. Zero functional impact on demo path. |
| EPIC-006: HITL (AV-07a) | **Second to cut** | Question generator stub (STORY-025) already in EPIC-004. `user_questions` table exists but is never written. No blocking in the run. The `QuestionList.tsx` component is never built. Zero impact on the drill-down path. |

### Top Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| LLM gateway choice (Q1) unresolved past Day 1 | Medium | High — blocks STORY-005 and all agent stories | Decide by end of Day 1. Default to OpenRouter if InsForge Gateway availability unclear. |
| OMDIA chunk not retrieved by similarity search (STORY-012 gate) | Medium | High — AC#10 fails | Run STORY-012 verification on Day 3–4, not Day 12. Fix at the embedding/ingest layer if it fails. |
| ABB PDFs not available (Q4) | Low (Harry has them) | High — blocks all of EPIC-002 | Confirm PDF availability on Day 1. Place in `docs/` before starting STORY-010. |
| Opus/Sonnet rate limits or latency during a full run | Medium | Medium — run takes >10 minutes | STORY-036 measures run time. Pre-caching (STORY-037) eliminates live LLM calls on demo day. |
| InsForge pgvector not enabled by default | Low | High — blocks STORY-003 | Verify pgvector extension in the InsForge dashboard on Day 1 alongside schema deployment. |
| React Flow layout not matching design intent | Low | Low | Clarify Kanban vs tree orientation with Harry before STORY-027 (noted as open in that story). |
| Tree Builder (STORY-016) produces wrong tree shape if LLM-driven | Low (config-driven recommended) | High — wrong tree means wrong drill-down | Use config-driven stub (Q5 recommendation). Do not use a live Sonnet call for tree building in v1. |
| Tier 2 (Build/Buy/Partner) activation surprises (Q6) | Medium | Medium — affects decision card content | Resolve Q6 before STORY-019. If Tier 2 is in scope, add 2 stories to EPIC-003. |

### Acceptance Criteria Coverage Map

| AC# | SPEC §12 | Story |
|-----|----------|-------|
| 1 | Case list, select ABB | STORY-009, STORY-028 |
| 2 | Run button + progress indicator | STORY-028 |
| 3 | Tree renders within 10 min / instantly if pre-cached | STORY-037 |
| 4 | Decision card: recommendation + weakest link | STORY-029, STORY-019, STORY-018 |
| 5 | Hypothesis drill-down with sub-hypothesis scores | STORY-030 |
| 6 | Sub-hypothesis evidence view | STORY-031 |
| 7 | Evidence source modal: URL + quote / PDF page | STORY-032 |
| 8 | Full drill-down path error-free | STORY-038 |
| 9 | Confidence math verifiable | STORY-018, STORY-036 |
| 10 | OMDIA chart / 10.4% CAGR under H1 | STORY-012 (ingest gate), STORY-023 (doc retrieval), STORY-032 (modal display) |

---

*Harry, before you hand any of these stories to Claude Code, please resolve the six Open Questions above — especially Q1 (LLM gateway), Q3 (HITL in or out), Q5 (Tree Builder LLM vs config), and Q6 (Tier 2 scope). These four unblocked decisions affect story sizing in EPIC-003 and EPIC-006 and are needed before Day 1 morning. Q2 and Q4 are confirmations that should take less than 5 minutes each.*
