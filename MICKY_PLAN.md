# Project: Micky — On-Demand Partner Memo Agent

> **Source spec:** `micky.md` (product discussion). Translated by `.claude/agents/system-analyst` with a compliance review by `.claude/agents/product-counsel`. This plan is the source of truth for the build; the discussion file is the source of truth for intent.

## How to run this with Claude Code

This plan is structured so a Claude Code agent can execute it story-by-story without re-reading the original discussion. Three usage patterns:

1. **One story at a time.** `Implement STORY-MICKY-1.1 from MICKY_PLAN.md`. Each story names its files, acceptance criteria, and smoke test. This is the safest mode for the critical path.
2. **One epic at a time.** `Work through EPIC-MICKY-2 from MICKY_PLAN.md story by story; verify each story's smoke test before moving on`.
3. **Drive the whole plan.** `Iterate through the Recommended Execution Order in MICKY_PLAN.md. Stop after each numbered step and run its smoke test before advancing.`

**Three hard gates apply across the whole plan — re-check them after every story:**

1. **Failure isolation.** `agents/orchestrator.ts` must have **zero imports** from `agents/micky.ts`. The pipeline must still produce a decision when Micky throws. Verify with `rg "from .*agents/micky" agents/orchestrator.ts` returning empty.
2. **Smoke tests, not unit tests.** This repo has no Jest/Vitest harness. Each agent or schema story carries a `scripts/smoke-*.ts` script. A story is not "done" until `npx tsx --conditions=import scripts/<name>.ts` exits 0.
3. **AI disclosure before any external demo.** `EPIC-MICKY-LEGAL` (specifically `STORY-MICKY-LEGAL-1`) must ship before Micky's memo is shown to anyone outside the build team — EU AI Act Art. 50(2) compliance.

**Out-of-band reviews to schedule:**
- After EPIC-MICKY-2 closes: invoke `.claude/agents/spaghetti-code-guardian` on `agents/micky.ts` (file size, prompt clarity, naming).
- After EPIC-MICKY-4 closes: invoke `.claude/agents/product-counsel` on the rendered memo + a sample export to confirm the disclosures land where the spec says they should.

## Summary

Micky is a post-decision pass that reads the full tree (including rejection logs from upstream agents), runs two focused LLM calls (a reframe attempt and a memo synthesizer), and produces a structured `MickyOutput` object that renders as both a standalone partner memo and as per-node callouts inside the existing hypothesis drilldown. He is strictly on-demand and failure-isolated — the existing decision still renders if Micky throws.

Build order follows the spec exactly: rejection logging → agent core (schema + LLM + persisted multi-attempt) → API trigger → memo UI → per-node annotations → ghost tree (ship-if-time).

**Architectural decisions resolved here (not deferred to the user):**

1. **`MickyOutput` persistence:** New `micky_runs` table with `(run_id, attempt_number, output JSONB, status, created_at)`. Storing on the decision node would break multi-attempt; the dedicated table makes each attempt an addressable row and lets the UI pick the best one. Recommended; justified.

2. **`consideredAlternatives` storage:** Optional field added to `ParsedBrief` (brief-framing alternatives, and framework alternatives via a second field `consideredFrameworks`), `HypothesisContent` (sub-hypothesis decomposition alternatives per slot, from tree-builder), and `DecisionContent` (decision-level alternatives from the Opus call). All JSONB — no migration column required, only TypeScript type changes. Since `brief-parser` and `framework-binder` are currently stubs, both will return `[]` for now; real values arrive when those agents get LLM calls in v2. The **decision agent** (real Opus call) is the only upstream agent that populates `consideredAlternatives` with genuine LLM reasoning in v1.

3. **Trigger:** Manual. `POST /api/runs/[id]/micky` fires an attempt; the orchestrator does NOT call Micky. A "Ask Micky" button in the UI (on the memo page; a navigation link from the decision card on `KanbanBoard.tsx`) triggers the route.

---

## Assumptions

- The `insforge` DB client is the only persistence path; direct SQL is used only in migration files.
- OpenRouter model for Micky: `sonnet` (`anthropic/claude-sonnet-4.6`). Rationale: Opus is reserved for the decision agent; Sonnet is used for evaluator, tier2, and contrarian — appropriate for Micky's synthesis role without burning Opus budget on every re-run. This is a prompt-engineering product (not a capability-limit problem), so Sonnet is sufficient.
- Migration timestamps are UTC, formatted as `YYYYMMDDHHmmss`. Use `20260507000000` as the Micky migration timestamp prefix (adjust to actual run time).
- The `app/case/[id]/page.tsx` file controls the case view layout; the memo page will be a sibling route at `app/case/[id]/memo/page.tsx`.
- `lib/api-client.ts` is assumed to exist (imported in `HypothesisDrilldown.tsx`); new fetch helpers for Micky routes go in the same file.
- Ghost tree requires React Flow to render faded rejected branches; it reuses the same library already imported in `HypothesisDrilldown.tsx`.

## Open Questions / Clarifications Needed

| # | Question | Who | Impact | Recommendation |
|---|----------|-----|--------|----------------|
| OQ-1 | Should the "Ask Micky" trigger appear on the main case view (`KanbanBoard`) or only on the Memo page? | PM | Changes where the button lives in STORY-MICKY-4.4 | **Recommendation:** Put a "View Micky's memo →" link on the decision card in `KanbanBoard.tsx` once a Micky run exists; the "Ask Micky / Regenerate" button lives on the memo page itself. This avoids cluttering the decision card but makes Micky discoverable. Mark open if the PM wants it on the card directly. |
| OQ-2 | Since `brief-parser` and `framework-binder` are stubs (no LLM call), their `consideredAlternatives` will be `[]` in v1. Is that acceptable for the demo? | PM | If no, these stubs need LLM calls added (significant scope expansion) | **Recommendation:** Acceptable — Micky skips the alternatives section for those agents when the array is empty, and the decision agent provides real alternatives. Note in the memo footer that framework alternatives will be populated "when v2 LLM parsing lands." |
| OQ-3 | Micky's LLM model: Sonnet or Opus? | CTO | Cost per re-run (Opus ≈ 15× Sonnet). Re-runnable 2–3× per case. | **Recommendation:** Sonnet. The value is in the prompts + structure, not raw capability. Switch to Opus if the persona quality is noticeably weaker after testing. |

---

## Epic Overview & Dependency Map

```
EPIC-MICKY-1: Rejection Logging
  (no upstream deps — runs entirely in existing agents)
       │
       ▼
EPIC-MICKY-2: Agent Core
  (depends on EPIC-MICKY-1 for consideredAlternatives to read)
       │
       ├─────────────────────────────┐
       ▼                             ▼
EPIC-MICKY-3: API Routes + Re-run    EPIC-MICKY-LEGAL: Compliance & Disclosure
  (depends on EPIC-MICKY-2)            (depends on EPIC-MICKY-2 schema only;
       │                                runs in parallel with EPIC-MICKY-3/4/5;
       ▼                                LEGAL-1 must close before any external demo)
EPIC-MICKY-4: Memo UI
  (depends on EPIC-MICKY-3: needs API routes to exist;
   STORY-MICKY-4.5 markdown-export integration is the
   surface that EPIC-MICKY-LEGAL guards)
       │
       ▼
EPIC-MICKY-5: Per-Node Annotations
  (depends on EPIC-MICKY-4: reuses MickyOutput already in DB)
       │
       ▼
EPIC-MICKY-6: Ghost Tree  [SHIP-IF-TIME]
  (depends on EPIC-MICKY-1 for consideredAlternatives on nodes;
   independent of EPIC-MICKY-4/5 — can be parallelised after EPIC-MICKY-1)
```

**Parallelisation opportunities:**
- After EPIC-MICKY-3 is complete: EPIC-MICKY-4 (Memo UI) and EPIC-MICKY-5's STORY-MICKY-5.1 (MickyAnnotation component, pure UI, no data dep) can be built in parallel.
- EPIC-MICKY-LEGAL stories 1 and 3 can start as soon as STORY-MICKY-2.1 (schema + table) lands. STORY-MICKY-LEGAL-2 has to wait for STORY-MICKY-4.5 (markdown export integration).

---

## Epic 1: Rejection Logging Infrastructure (ID: EPIC-MICKY-1)

**User Value:** Micky gets real rejection data from upstream agents. Without this epic, Micky hallucinate alternatives; with it, the "considered but cut" sections are grounded in actual reasoning.

**Dependencies:** None — modifies only TypeScript types and existing agent stubs.

**Estimated Total Effort:** ~2 engineer-days

---

### STORY-MICKY-1.1: Extend schema types with `consideredAlternatives`

- **Type:** Technical Story
- **Statement:** As a developer, I need `consideredAlternatives` optional fields on `ParsedBrief`, `HypothesisContent`, and `DecisionContent` so that upstream agents have a typed surface to emit rejection logs and Micky can read them.
- **Files to modify:**
  - `lib/schema.ts` — add optional fields (no DB migration needed; all content is JSONB)
- **Acceptance Criteria:**
  - [ ] `ParsedBrief` gains `consideredAlternatives?: { name: string; whyCut: string }[]` (brief-framing alternatives) and `consideredFrameworks?: { name: string; whyCut: string }[]` (framework-selection alternatives)
  - [ ] `HypothesisContent` gains `consideredAlternatives?: { name: string; whyCut: string }[]` (sub-hypothesis decomposition alternatives)
  - [ ] `DecisionContent` gains `consideredAlternatives?: { name: string; whyCut: string }[]` (decision-level alternatives)
  - [ ] All new fields are `readonly`-compatible and carry a JSDoc comment referencing Micky
  - [ ] `npx tsc --noEmit` passes with no new errors
- **Complexity:** Small
- **Dependencies:** None

---

### STORY-MICKY-1.2: Brief-parser and framework-binder emit `consideredAlternatives`

- **Type:** Technical Story
- **Statement:** As a developer, I need `parseBrief` and `bindFramework` to populate their respective `consideredAlternatives` fields so the field exists in the DB for Micky to read (even if empty for now).
- **Files to modify:**
  - `agents/brief-parser.ts` — add `consideredAlternatives: []` and `consideredFrameworks: []` to the returned `ParsedBrief`
  - `agents/framework-binder.ts` — add `consideredAlternatives: []` to each `BoundSlot` in the returned `FrameworkBinding`. Also add `consideredAlternatives?: { name: string; whyCut: string }[]` to the `BoundSlot` interface
- **Acceptance Criteria:**
  - [ ] `parseBrief` returns an object where `consideredAlternatives` and `consideredFrameworks` are present (both `[]` in the stub)
  - [ ] `bindFramework` returns a `FrameworkBinding` where each slot has `consideredAlternatives: []`
  - [ ] `npx tsc --noEmit` passes
  - [ ] Existing smoke tests that call the orchestrator still pass (fields are additive to JSONB)
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-1.1

---

### STORY-MICKY-1.3: Decision agent emits `consideredAlternatives` via Opus

- **Type:** Technical Story
- **Statement:** As a developer, I need the Opus call in `agents/decision.ts` to return `consideredAlternatives` (2–4 paths evaluated and why they were cut) so Micky has real rejection data from the most consequential upstream agent.
- **Files to modify:**
  - `agents/decision.ts` — update `callOpus` system prompt to require a `consideredAlternatives` field in its JSON response; update the return type and `content` assembly to include it; persist it on the decision node's `content`
- **Acceptance Criteria:**
  - [ ] The `callOpus` system prompt instructs Opus to return `"consideredAlternatives": [{"name": "...", "whyCut": "..."}]` with 2–4 items (e.g., alternative decision framings, alternative entry modes that were seriously weighed but cut)
  - [ ] The `callOpus` return type includes `consideredAlternatives: { name: string; whyCut: string }[]`
  - [ ] The assembled `DecisionContent` includes `consideredAlternatives` (empty array if Opus omits it; guarded with `?? []`)
  - [ ] `npx tsc --noEmit` passes
  - [ ] Running the pipeline against `abb-rack-pdu` and exporting with `scripts/export-run-markdown.ts` shows `consideredAlternatives` populated on the decision node
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-1.1

---

### STORY-MICKY-1.4: Smoke test for rejection logging

- **Type:** Technical Story
- **Statement:** As a developer, I need a smoke script that verifies `ParsedBrief`, `BoundSlot`, and `DecisionContent` objects all carry the `consideredAlternatives` field (present, typed correctly) so regressions are caught early.
- **Files to create:**
  - `scripts/smoke-rejection-logging.ts`
- **Acceptance Criteria:**
  - [ ] Script instantiates the minimal shape of each type (using type assertions, not real LLM calls) and asserts `Array.isArray(obj.consideredAlternatives)` for each
  - [ ] Script calls `parseBrief("abb-rack-pdu")` (stub — no LLM) and asserts the returned `ParsedBrief` has `consideredAlternatives` as an array
  - [ ] Script calls `bindFramework("abb-rack-pdu")` and asserts each slot has `consideredAlternatives` as an array
  - [ ] `npx tsx --conditions=import scripts/smoke-rejection-logging.ts` exits 0
  - [ ] Deliberately omitting the field causes the script to exit non-zero
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-1.1, STORY-MICKY-1.2

---

## Epic 2: Micky Agent Core (ID: EPIC-MICKY-2)

**User Value:** The first end-to-end Micky run can be triggered and persisted. A developer can call the agent function directly and see a structured `MickyOutput` with a real reframe attempt and a fully populated memo.

**Dependencies:** EPIC-MICKY-1 (for `consideredAlternatives` to be present on tree nodes when Micky reads them)

**Estimated Total Effort:** ~4 engineer-days

---

### STORY-MICKY-2.1: `micky_runs` DB table + `MickyRun` schema type

- **Type:** Technical Story
- **Statement:** As a developer, I need a `micky_runs` table and a matching TypeScript type so that multiple Micky attempts per run can be persisted and the UI can pick the best one.
- **Files to create/modify:**
  - `migrations/20260507000000_micky-runs.sql` — create table
  - `lib/schema.ts` — add `MickyOutput` type, `MickyRun` row type, `MickyRunStatus` type
- **Migration SQL:**
  ```sql
  create table micky_runs (
    id uuid primary key default gen_random_uuid(),
    run_id uuid not null references runs(id) on delete cascade,
    attempt_number integer not null,
    status text not null default 'pending'
      check (status in ('pending','running','complete','failed')),
    output jsonb,
    error text,
    created_at timestamptz default now(),
    completed_at timestamptz,
    unique (run_id, attempt_number)
  );
  create index on micky_runs(run_id);
  ```
- **TypeScript types to add to `lib/schema.ts`:**
  ```ts
  export type MickyRunStatus = 'pending' | 'running' | 'complete' | 'failed';

  export interface MickyReframe {
    headline: string;
    reasoning: string;
  }

  export interface MickyOutput {
    reframe: MickyReframe | null;
    recommendation: { oneLiner: string; weakestLink: string; whatWouldFlipIt: string };
    frameworkRationale: { chosen: string; rejected: { name: string; whyCut: string }[] };
    hypothesisRanking: { id: string; rank: number; whyThisRank: string }[];
    hypothesisDecomposition: { hypId: string; whyThese: string; whatWasCut: string[] }[];
    judgmentCalls: { area: string; thinness: string; whyIWentThere: string }[];
    pushback: { challenge: string }[];
    signOff: { date: string; monogram: 'MB' };
  }

  export interface MickyRun {
    id: string;
    run_id: string;
    attempt_number: number;
    status: MickyRunStatus;
    output: MickyOutput | null;
    error: string | null;
    created_at: string;
    completed_at: string | null;
  }
  ```
- **Acceptance Criteria:**
  - [ ] Migration file parses and applies cleanly (test by running the Supabase MCP or equivalent migration tooling)
  - [ ] `lib/schema.ts` exports all four new types; `npx tsc --noEmit` passes
  - [ ] `MickyOutput.pushback` is included (the "How I'd push back" section — v1, not deferred)
  - [ ] `micky_runs` has a `unique (run_id, attempt_number)` constraint
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-1.1

---

### STORY-MICKY-2.2: Add `micky` role to LLM client

- **Type:** Technical Story
- **Statement:** As a developer, I need a `micky` role in `lib/llm-client.ts` that routes to Sonnet so Micky calls are traceable by role in logs and `model_used` fields.
- **Files to modify:**
  - `lib/llm-client.ts` — add `"micky"` to `AgentRole` union; add `micky: MODELS.sonnet` to `MODEL_MAP`
- **Acceptance Criteria:**
  - [ ] `AgentRole` includes `"micky"`
  - [ ] `MODEL_MAP["micky"]` resolves to `MODELS.sonnet`
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** None (independent of EPIC-MICKY-1; can run in parallel with STORY-MICKY-1.x)

---

### STORY-MICKY-2.3: Author Micky system prompts (reframe + memo)

- **Type:** Technical Story
- **Statement:** As a developer, I need the two system prompts (reframe and memo synthesizer) authored inside `agents/micky.ts` following the four anti-AI-tell rules so that Micky's persona is credible and testable against the spec.
- **Files to create:**
  - `agents/micky.ts` — create the file with exported `MICKY_REFRAME_SYSTEM_PROMPT` and `MICKY_MEMO_SYSTEM_PROMPT` string constants (prompts only; no LLM calls yet — those land in STORY-MICKY-2.4 and STORY-MICKY-2.5)
- **Acceptance Criteria:**
  - [ ] **Banned words:** Both prompts explicitly forbid (by name in a "DO NOT use" clause): `delve`, `tapestry`, `robust`, `comprehensive`, `multifaceted`
  - [ ] **Fragment guidance:** Both prompts instruct the model to prefer short sentences and fragments over subordinate clauses; include the example from the spec verbatim: `"Two things stand out. One: market is real. Two: timing isn't."` as a positive example
  - [ ] **Specificity rule:** The memo prompt instructs Micky to name the specific data point, document, or year that makes a claim thin — not vague hedges (include spec example: `"Confidence on H2 is thin because the parity-cost data is from 2022"` as positive, `"there is some uncertainty around competitive positioning"` as negative)
  - [ ] **Opinion-allowed clause:** Both prompts include explicit permission for Micky to disagree with the analysis: `"You may disagree with the tree's recommendation. If you do, say so directly."` (or equivalent)
  - [ ] **Few-shot example:** The memo prompt includes one complete hand-authored partner memo example (minimum: recommendation + one judgment-call + sign-off) written in Micky's style, demonstrating fragments, monogram, and "considered but cut" phrasing
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-2.2

---

### STORY-MICKY-2.4: `agents/micky.ts` — reframe call

- **Type:** Technical Story
- **Statement:** As a developer, I need a `runReframe(context: MickyContext): Promise<MickyReframe | null>` function in `agents/micky.ts` that makes a single focused LLM call asking whether the brief's question is well-posed, with explicit permission to return null.
- **Files to modify:**
  - `agents/micky.ts` — add `MickyContext` interface and `runReframe` function
- **`MickyContext` interface (define in `agents/micky.ts`):**
  ```ts
  interface MickyContext {
    caseId: string;
    runId: string;
    caseTitle: string;
    caseQuestion: string;
    parsedBrief: ParsedBrief;
    frameworkBinding: FrameworkBinding;  // carry from orchestrator via DB or re-load
    tree: TreeNode[];
  }
  ```
- **Acceptance Criteria:**
  - [ ] `runReframe` sends a user prompt that includes the case question, the parsed brief's info-gaps and risks, and a direct instruction: `"If the question is well-posed, return null. Do not force a reframe."`
  - [ ] Returns `MickyReframe | null`; a `null` return (when the model outputs `{"reframe": null}` or an equivalent signal) is valid and not treated as an error
  - [ ] Uses `completeJson<{ reframe: MickyReframe | null }>("micky", messages, { temperature: 0.7 })` — higher temperature than evaluator to allow lateral thinking
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-2.2, STORY-MICKY-2.3

---

### STORY-MICKY-2.5: `agents/micky.ts` — memo synthesizer, pushback section, and persistence

- **Type:** Technical Story
- **Statement:** As a developer, I need a `runMicky(runId: string, caseConfigId: string): Promise<MickyOutput>` top-level function that assembles context, runs the reframe call, runs the memo synthesizer, writes the result to `micky_runs`, and is failure-isolated.
- **Files to modify:**
  - `agents/micky.ts` — add `runMemoSynthesizer`, `runMicky`, and DB persistence helpers
- **Acceptance Criteria:**
  - [ ] `runMicky` fetches all tree nodes and the case row from the DB to build `MickyContext` (does not accept pre-built context as a parameter — it reads fresh from DB so it's independently re-runnable)
  - [ ] `runMicky` computes `attemptNumber` by querying `SELECT COALESCE(MAX(attempt_number), 0) + 1 FROM micky_runs WHERE run_id = $runId` before inserting a new `micky_runs` row with `status='running'`
  - [ ] `runMemoSynthesizer` receives the reframe result (or null), the full tree, and `consideredAlternatives` extracted from the decision node and hypothesis nodes; produces a `MickyOutput` via `completeJson<MickyOutput>("micky", ...)`
  - [ ] `MickyOutput.pushback` is populated: the memo prompt instructs Micky to include 2–3 items in `pushback` listing the challenges a skeptical reader should raise (the "How I'd push back on this memo" section — v1, not optional)
  - [ ] `MickyOutput.judgmentCalls` items follow the spec shape: each names the **thinness** AND **what evidence would resolve it** (not just a vague hedge)
  - [ ] On success: `micky_runs` row updated with `status='complete'`, `output=<MickyOutput>`, `completed_at=now()`
  - [ ] On failure: `micky_runs` row updated with `status='failed'`, `error=<message>`. **The function throws after persisting the failure** (the API route catches it; consistent with contrarian-pass pattern)
  - [ ] `runMicky` is **not** called from `agents/orchestrator.ts` — the orchestrator has no import of `agents/micky.ts`
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Large
- **Dependencies:** STORY-MICKY-2.1, STORY-MICKY-2.3, STORY-MICKY-2.4

---

## Epic 3: API Routes + Re-run Support (ID: EPIC-MICKY-3)

**User Value:** The UI can trigger a Micky run and fetch all attempts. The "regenerate" affordance is backed by real data.

**Dependencies:** EPIC-MICKY-2 (needs `agents/micky.ts` and `micky_runs` table)

**Estimated Total Effort:** ~1.5 engineer-days

---

### STORY-MICKY-3.1: `POST /api/runs/[id]/micky` trigger route

- **Type:** Technical Story
- **Statement:** As a developer, I need a POST route that triggers a Micky attempt for a given `runId` in a detached background Promise (same pattern as `POST /api/runs`), returns 202 with `{ mickyRunId, attemptNumber }`, and is failure-isolated.
- **Files to create:**
  - `app/api/runs/[id]/micky/route.ts`
- **Acceptance Criteria:**
  - [ ] Route handler: validates that the parent `runs` row exists and has `status='complete'` (Micky only runs after the pipeline finishes); returns 400 if not
  - [ ] Calls `runMicky(runId, caseConfigId)` in a detached Promise (`.catch(e => console.error(...))` on the background promise — same pattern as `POST /api/runs`)
  - [ ] Returns 202 `{ mickyRunId, attemptNumber }` immediately after creating the `micky_runs` row (before the LLM calls complete)
  - [ ] `export const runtime = "nodejs"` and `export const dynamic = "force-dynamic"` set as per other routes
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-2.5

---

### STORY-MICKY-3.2: `GET /api/runs/[id]/micky` fetch route + `lib/api-client.ts` helpers

- **Type:** Technical Story
- **Statement:** As a developer, I need a GET route that returns all `micky_runs` for a given `runId` (latest first) so the UI can display the current attempt and a list of prior attempts to pick from.
- **Files to create/modify:**
  - `app/api/runs/[id]/micky/route.ts` — add `GET` handler alongside the existing `POST`
  - `lib/api-client.ts` — add `fetchMickyRuns(runId: string): Promise<MickyRun[]>` and `triggerMickyRun(runId: string): Promise<{ mickyRunId: string; attemptNumber: number }>` helpers
- **Acceptance Criteria:**
  - [ ] `GET /api/runs/[id]/micky` returns `{ runs: MickyRun[] }` ordered by `attempt_number DESC`
  - [ ] Returns `{ runs: [] }` (not 404) when no Micky runs exist yet
  - [ ] `fetchMickyRuns` in `lib/api-client.ts` throws on non-2xx with the error body text
  - [ ] `triggerMickyRun` in `lib/api-client.ts` POSTs and returns `{ mickyRunId, attemptNumber }`
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-3.1

---

### STORY-MICKY-3.3: Smoke test for Micky agent end-to-end

- **Type:** Technical Story
- **Statement:** As a developer, I need a smoke script that runs a complete Micky attempt against the `abb-rack-pdu` case (requires a live DB and OpenRouter key) and validates the output schema.
- **Files to create:**
  - `scripts/smoke-micky-agent.ts`
- **Acceptance Criteria:**
  - [ ] Script calls `runMicky(runId, "abb-rack-pdu")` using a real `runId` passed via `process.argv[2]` (or defaults to the most recent complete run for `abb-rack-pdu`)
  - [ ] Asserts that `output.recommendation.oneLiner` is a non-empty string
  - [ ] Asserts that `output.hypothesisRanking.length > 0`
  - [ ] Asserts that `output.signOff.monogram === "MB"`
  - [ ] Asserts that `output.pushback.length >= 1` (pushback section is present)
  - [ ] Checks that none of the banned words (`delve`, `tapestry`, `robust`, `comprehensive`, `multifaceted`) appear in `JSON.stringify(output)` — exits non-zero with a diagnostic if they do
  - [ ] `npx tsx --conditions=import scripts/smoke-micky-agent.ts <runId>` exits 0 on a valid run; exits non-zero if any assertion fails
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-2.5

---

## Epic 4: Memo UI (ID: EPIC-MICKY-4)

**User Value:** A user can navigate to `/case/[id]/memo`, see the full partner memo with all sections rendered, trigger a new Micky attempt, and select between prior attempts to compare outputs.

**Dependencies:** EPIC-MICKY-3 (needs API routes)

**Estimated Total Effort:** ~3 engineer-days

---

### STORY-MICKY-4.1: Memo page shell and routing

- **Type:** Technical Story
- **Statement:** As a developer, I need the page shell at `app/case/[id]/memo/page.tsx` with a `useQuery` hook wired to `fetchMickyRuns`, loading/error/empty states, and the page's overall cream-paper visual container.
- **Files to create:**
  - `app/case/[id]/memo/page.tsx`
- **Acceptance Criteria:**
  - [ ] Page is a `"use client"` component; accepts `params: { id: string }` (the case ID)
  - [ ] Resolves the latest complete run for the case (via a `GET /api/cases/[id]/runs/latest` call, which already exists) to get `runId`, then calls `fetchMickyRuns(runId)`
  - [ ] Loading state: spinner or `"Loading Micky's memo…"` text
  - [ ] Empty state (no Micky runs yet): shows "No memo yet." with a prominent "Ask Micky" button that calls `triggerMickyRun`
  - [ ] Page wrapper uses `className="min-h-screen bg-[#faf8f3] font-sans"` (cream background) as the outer container; all memo content inside a `max-w-2xl mx-auto px-8 py-12` inner div
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-3.2

---

### STORY-MICKY-4.2: Full memo rendering component

- **Type:** User Story
- **Statement:** As a user, I want to read Micky's partner memo in a visual format that feels like a real colleague's note — with the reframe as the dominant element, structured sections, and an honest judgment-calls section.
- **Files to create:**
  - `components/MickyMemo.tsx` — pure presentational component; accepts `output: MickyOutput`
- **Render order and visual spec:**
  1. **Reframe** (if non-null): `text-3xl font-serif text-stone-900 leading-snug` — largest type on the page. Label: `MB REFRAME` in `text-[10px] uppercase tracking-widest text-stone-500` above it. If `reframe === null`, render a small italic note: `"Question is well-posed — no reframe suggested."` at smaller size.
  2. **Recommendation**: `text-base font-medium text-stone-800` for `oneLiner`; below it, two lines in `text-sm text-stone-600`: "Weakest link: …" and "What would flip it: …"
  3. **Framework rationale**: chosen framework label in normal weight; below it, each `rejected` item as gray italic `text-sm text-stone-400 italic` with a left-border `border-l-2 border-stone-200 pl-3`
  4. **Hypothesis ranking**: numbered list; each entry shows rank, `whyThisRank` in normal weight; no `consideredAlternatives` here (those live in per-node annotations)
  5. **Hypothesis decomposition**: for each entry, `whyThese` in normal weight; `whatWasCut` items as gray italic with the same left-border treatment as rejected frameworks
  6. **Judgment calls**: for each item, `area` in `font-medium text-stone-700`; `thinness` in normal `text-stone-600`; `whyIWentThere` in `text-sm text-stone-400 italic`
  7. **Pushback section** (header: `"How I'd push back on this memo"`): each `challenge` as a bullet in `text-sm text-stone-600`
  8. **Sign-off**: `MB` monogram in a `w-8 h-8 rounded-full bg-stone-800 text-white text-sm flex items-center justify-center` circle; date in `text-xs text-stone-400` beside it
- **Acceptance Criteria:**
  - [ ] All 8 sections render with the visual spec above
  - [ ] `reframe === null` renders the fallback italic note rather than crashing
  - [ ] Empty arrays (`hypothesisRanking: []`, etc.) render nothing rather than broken section headers
  - [ ] `MickyMemo` is a pure component (no hooks, no fetching) — all data passed as props
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Large
- **Dependencies:** STORY-MICKY-2.1 (for `MickyOutput` type), STORY-MICKY-4.1

---

### STORY-MICKY-4.3: Regenerate button and attempt selector

- **Type:** User Story
- **Statement:** As a user, I want to run Micky again and pick between prior attempts so I can use multi-attempt re-running as a quality lever.
- **Files to modify:**
  - `app/case/[id]/memo/page.tsx` — add regenerate button and attempt selector UI
- **Acceptance Criteria:**
  - [ ] "Regenerate" button calls `triggerMickyRun(runId)`, sets loading state, then re-fetches `fetchMickyRuns` after 500ms polling until a new `complete` row appears (or a `failed` row, which renders the error)
  - [ ] When `runs.length > 1`, a `<select>` or segmented control shows "Attempt 1", "Attempt 2", etc. and controls which attempt's `MickyOutput` is passed to `MickyMemo`
  - [ ] Currently-displayed attempt defaults to the latest `complete` attempt
  - [ ] During an in-flight Micky attempt (`status='running'`), the regenerate button shows "Running…" and is disabled
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-4.2

---

### STORY-MICKY-4.4: Navigation link from case view to memo page

- **Type:** User Story
- **Statement:** As a user, I want to discover Micky's memo from the main case view so I don't have to know to navigate to `/memo` manually.
- **Files to modify:**
  - `components/KanbanBoard.tsx` — add a "View Micky's memo →" link to the `DecisionCard` component, shown only when at least one complete `micky_runs` row exists for the current run
  - `app/case/[id]/page.tsx` — add a subtle "Ask Micky" pill/link below the decision section that always navigates to `/case/[id]/memo` (even when no runs exist — the memo page handles the empty state)
- **Acceptance Criteria:**
  - [ ] "View Micky's memo →" link in `DecisionCard` only renders when `hasMickyRun` prop is `true`; `KanbanBoard` fetches `fetchMickyRuns(runId)` to determine this (the call is already needed for STORY-MICKY-5.2, so this adds minimal overhead)
  - [ ] The link uses `next/link` and navigates to `/case/[caseId]/memo`
  - [ ] The "Ask Micky" pill is always visible in `app/case/[id]/page.tsx` as a secondary CTA below the board
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-4.1, STORY-MICKY-3.2

---

### STORY-MICKY-4.5: Markdown export integration for Micky's memo

- **Type:** Technical Story
- **Statement:** As a user, I want `scripts/export-run-markdown.ts` to include Micky's latest memo so the exported run report carries the partner-style note alongside the tree. This story is also the surface that EPIC-MICKY-LEGAL-2 (export guardrails) instruments — without it there is nothing to guard.
- **Files to modify:**
  - `scripts/export-run-markdown.ts` — fetch the latest `complete` `micky_runs` row for the run, render the eight memo sections as a top-level `## Micky's Memo` block (mirroring the visual order from `MickyMemo.tsx`), and a per-hypothesis `**Micky's note:**` line inside each hypothesis section drawn from `hypothesisRanking` / `hypothesisDecomposition`
- **Acceptance Criteria:**
  - [ ] Export now contains a `## Micky's Memo` H2 section between the existing `## Decision` and `## Hypotheses` sections **only when** at least one `complete` Micky run exists; absent gracefully when none
  - [ ] Memo section renders all 8 of: reframe (or "no reframe — question well-posed"), recommendation, framework rationale (with rejected items as italic indented bullets), hypothesis ranking, hypothesis decomposition (`whyThese` + `whatWasCut`), judgment calls, pushback, sign-off (`— MB · YYYY-MM-DD`)
  - [ ] Each hypothesis block in the existing `## Hypotheses` section gains a `**Micky's note:**` line under the rationale when a matching `hypothesisRanking` entry exists
  - [ ] Multiple Micky attempts: export uses the highest `attempt_number` with `status='complete'` (latest "good" attempt)
  - [ ] Smoke test (extend `scripts/smoke-micky-agent.ts` from STORY-MICKY-3.3, OR a new `scripts/smoke-micky-export.ts`): runs the exporter against the `abb-rack-pdu` run after a Micky run has completed, asserts the resulting markdown file contains the `## Micky's Memo` heading and the `— MB ·` sign-off literal
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Medium
- **Dependencies:** STORY-MICKY-2.5, STORY-MICKY-2.1

---

## Epic 5: Per-Node Annotations (ID: EPIC-MICKY-5)

**User Value:** When a user drills into Hypothesis 3, they see Micky's note (1–3 sentences, MB monogram) explaining why Micky ranked it there and what sub-hypotheses were cut. No additional agent call — reuses the already-persisted `MickyOutput`.

**Dependencies:** EPIC-MICKY-4 (needs `MickyOutput` in DB; needs `fetchMickyRuns` in `lib/api-client.ts`)

**Estimated Total Effort:** ~1 engineer-day

---

### STORY-MICKY-5.1: `MickyAnnotation` component

- **Type:** Technical Story
- **Statement:** As a developer, I need a small `MickyAnnotation` component that renders Micky's per-node callout (italic text + MB monogram) so it can be dropped into any node view without duplicating markup.
- **Files to create:**
  - `components/MickyAnnotation.tsx`
- **Props interface:**
  ```ts
  interface MickyAnnotationProps {
    rankEntry: MickyOutput['hypothesisRanking'][number] | null;
    decompEntry: MickyOutput['hypothesisDecomposition'][number] | null;
  }
  ```
- **Acceptance Criteria:**
  - [ ] Renders nothing when both props are `null` (hypothesis not covered in Micky's output)
  - [ ] Renders an `<aside>` with `border-l-2 border-stone-300 pl-3 text-sm italic text-neutral-400` containing: `"Micky's note: {rankEntry.whyThisRank}"` followed (if `decompEntry`) by `"I considered {decompEntry.whatWasCut.join(', ')} but cut them — {decompEntry.whyThese}"`
  - [ ] MB monogram: a small `w-5 h-5 rounded-full bg-stone-700 text-white text-[9px]` circle with "MB" inline before the text
  - [ ] Component is a pure function (no hooks)
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-2.1 (for `MickyOutput` type)

---

### STORY-MICKY-5.2: Wire `MickyAnnotation` into `HypothesisDrilldown`

- **Type:** User Story
- **Statement:** As a user, when I drill into a hypothesis, I want to see Micky's annotation for that hypothesis (if a Micky run exists) so I get immediate context on why it was ranked and what was cut.
- **Files to modify:**
  - `components/HypothesisDrilldown.tsx` — add `useQuery` for `fetchMickyRuns(runId)`, extract the latest complete attempt's output, find the matching `hypothesisRanking` and `hypothesisDecomposition` entries by `hypothesisId`, pass to `MickyAnnotation`
- **Acceptance Criteria:**
  - [ ] `HypothesisDrilldown` fetches `fetchMickyRuns(runId)` (stale-while-revalidate; does not block render)
  - [ ] If no Micky runs exist or the latest is not `complete`, no annotation renders (graceful empty state)
  - [ ] `MickyAnnotation` is rendered directly below the hypothesis claim/confidence block, above the React Flow canvas
  - [ ] For each sub-hypothesis card in the list at the bottom, a `MickyAnnotation` with `rankEntry=null` and `decompEntry` (matching the parent hypothesis decomp entry) can optionally be shown — implement this only if it doesn't clutter the card
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-5.1, STORY-MICKY-3.2

---

## Epic 6: Ghost Tree [SHIP-IF-TIME] (ID: EPIC-MICKY-6)

**User Value:** Users can toggle a faded silhouette of rejected sub-hypotheses alongside the chosen tree — making "what we considered but cut" tangible in a way no prose can. This is the demo moment.

**Dependencies:** EPIC-MICKY-1 (for `consideredAlternatives` on `HypothesisContent`); independent of EPIC-MICKY-4/5

**Estimated Total Effort:** ~2 engineer-days

> **Mark as ship-if-time.** Do not block a demo on this epic. Implement after all prior epics are verified.

---

### STORY-MICKY-6.1: `GhostTree` React Flow component

- **Type:** User Story
- **Statement:** As a user, I want to see faded "ghost" nodes representing sub-hypotheses that were considered but cut so that the tree's choices feel grounded rather than arbitrary.
- **Files to create:**
  - `components/GhostTree.tsx`
- **Acceptance Criteria:**
  - [ ] Accepts `tree: TreeNode[]` (the live tree) and `visible: boolean` props
  - [ ] For each `hypothesis` node, reads `(node.content as HypothesisContent).consideredAlternatives` and renders those as additional React Flow nodes at the same depth as the sub-hypothesis row, with `opacity: 0.25` and a dashed `border-style: dashed` style
  - [ ] Ghost nodes are not interactive (no `onNodeClick` — they are visual-only)
  - [ ] When `visible=false`, renders nothing (the toggle is controlled by the parent)
  - [ ] A small italic label `"(considered, not used)"` appears below each ghost node label
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Large
- **Dependencies:** STORY-MICKY-1.1

---

### STORY-MICKY-6.2: Ghost tree toggle in `HypothesisDrilldown`

- **Type:** User Story
- **Statement:** As a user, I want a toggle button in the hypothesis drilldown that shows or hides the ghost tree so I can opt into the "what was cut" view without it dominating the default UI.
- **Files to modify:**
  - `components/HypothesisDrilldown.tsx` — add `showGhost: boolean` state; add toggle button; render `<GhostTree>` inside or alongside the React Flow canvas when `showGhost=true`
- **Acceptance Criteria:**
  - [ ] Toggle button: `"Show rejected branches"` / `"Hide rejected branches"`, positioned in the top-right of the React Flow container
  - [ ] Ghost nodes are layered behind the live tree (lower `zIndex` or rendered first so live nodes sit on top)
  - [ ] When `consideredAlternatives` is empty on all hypothesis nodes, the toggle button is hidden (nothing to show)
  - [ ] `npx tsc --noEmit` passes
- **Complexity:** Small
- **Dependencies:** STORY-MICKY-6.1

---

## Recommended Execution Order

This is a literal to-do list for a Claude Code agent or engineer. Execute sequentially unless a step is marked **(parallel OK with [X])**.

```
1.  STORY-MICKY-1.1  — Extend lib/schema.ts with consideredAlternatives fields
2.  STORY-MICKY-1.2  — Brief-parser + framework-binder emit consideredAlternatives: []
3.  STORY-MICKY-1.3  — Decision agent emits consideredAlternatives via Opus prompt update
4.  STORY-MICKY-1.4  — scripts/smoke-rejection-logging.ts (verify steps 1–3)
5.  STORY-MICKY-2.1  — migrations/20260507000000_micky-runs.sql + MickyOutput/MickyRun types in lib/schema.ts
6.  STORY-MICKY-2.2  — Add micky role to lib/llm-client.ts   (parallel OK with step 5)
7.  STORY-MICKY-2.3  — Author Micky system prompts in agents/micky.ts (reframe + memo constants)
8.  STORY-MICKY-2.4  — agents/micky.ts: runReframe function
9.  STORY-MICKY-2.5  — agents/micky.ts: runMemoSynthesizer + runMicky (pushback included, DB persistence)
10. STORY-MICKY-3.1  — app/api/runs/[id]/micky/route.ts: POST handler
11. STORY-MICKY-3.2  — GET handler in same route file + lib/api-client.ts helpers
12. STORY-MICKY-3.3  — scripts/smoke-micky-agent.ts (end-to-end, requires live credentials)
13. STORY-MICKY-4.1  — app/case/[id]/memo/page.tsx: shell + routing   (parallel OK with step 12)
14. STORY-MICKY-4.2  — components/MickyMemo.tsx: full memo renderer
15. STORY-MICKY-4.3  — Regenerate button + attempt selector in memo page
16. STORY-MICKY-4.4  — Navigation links in KanbanBoard.tsx + app/case/[id]/page.tsx
17. STORY-MICKY-5.1  — components/MickyAnnotation.tsx              (parallel OK with step 16)
18. STORY-MICKY-5.2  — Wire MickyAnnotation into HypothesisDrilldown.tsx
19. [SHIP-IF-TIME] STORY-MICKY-6.1 — components/GhostTree.tsx
20. [SHIP-IF-TIME] STORY-MICKY-6.2 — Ghost tree toggle in HypothesisDrilldown.tsx
```

---

## Risk & Dependency Summary

| Risk | Severity | Story | Mitigation |
|------|----------|-------|------------|
| Opus returns `consideredAlternatives` with fewer than 2 items or omits the field | Medium | STORY-MICKY-1.3 | Guard with `?? []` in the assembly; smoke test asserts field exists |
| Micky's Sonnet output fails `MickyOutput` JSON schema (field missing, wrong type) | High | STORY-MICKY-2.5 | Add explicit field-presence guards after `completeJson` call; if required fields missing, throw and persist `status='failed'` rather than corrupting the row |
| Banned-word check in smoke test fires on a legitimate case-specific term | Low | STORY-MICKY-3.3 | Make banned-word list case-insensitive whole-word match; log the offending sentence rather than just the word |
| Memo page renders with no Micky run (first load is always empty) | Low | STORY-MICKY-4.1 | Empty state UX is an explicit AC in STORY-MICKY-4.1 |
| `fetchMickyRuns` called twice per render in `KanbanBoard` + `HypothesisDrilldown` | Low | STORY-MICKY-5.2 / STORY-MICKY-4.4 | Both calls share the same React Query key `["micky-runs", runId]` — deduplicated by the cache |
| Ghost tree nodes overlap live nodes, making the canvas unreadable | Medium | STORY-MICKY-6.1 | Use a separate React Flow layer or manually offset ghost node positions; AC requires live nodes sit visually on top |

**Critical path:** STORY-MICKY-1.1 → 2.1 → 2.3 → 2.5 → 3.1 → 4.1 → 4.2. This chain is 7 stories deep and cannot be parallelised. Everything else (STORY-MICKY-2.2, STORY-MICKY-5.1, Ghost Tree) is off the critical path and can proceed in parallel or be deferred without blocking the demo.

**Failure isolation checkpoint:** Confirm that `agents/orchestrator.ts` has **zero imports from `agents/micky.ts`** before closing STORY-MICKY-2.5. This is the single most important architectural invariant for Micky — if it is violated, a Micky bug will block the entire pipeline.
