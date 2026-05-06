# Project: Agent Victor v2

> **Status:** Active plan. Authored 2026-05-05. Execute after reviewing; do not run automatically.

---

## Summary

Three confirmed defects and one visibility gap are addressed across five epics:

1. **EPIC-V2-A — PDF vision ingestion.** Charts on slide 8 of `abb-rack-pdu-deck.pdf` are bitmap-rendered and invisible to `unpdf`'s text extraction. A vision pass (Gemini Pro via OpenRouter) runs per page and its output is merged with the text-extracted content before embedding. A force-reingest path clears and rebuilds source rows for a single case.

2. **EPIC-V2-B — Deeper web research.** `WEB_RESULTS_PER_LEAF` is currently 3 and only the 280-char snippet (not the full Tavily `content`) reaches the scoring LLM. Bumping to 6 results, piping full content (truncated at 3000 chars), and adding Mistral-generated query variants will roughly double the evidence count and improve quote quality.

3. **EPIC-V2-C — Contrarian / red-team pass.** No model currently challenges the emerging conclusion. A Sonnet-driven pass runs after rollup, targets the top-2 highest-confidence hypotheses, and writes 1-2 `supports='against'` evidence children per hypothesis. This makes multi-model disagreement a tangible demo artefact.

4. **EPIC-V2-D — Multi-model UI surfacing.** The model tag on evidence rows is 10px and nearly invisible. The decision card hardcodes "Opus" in plain text. A "models used" footer on the decision card and larger model badges on evidence rows make the multi-model architecture immediately legible to a demo viewer.

5. **EPIC-V2-E — Verification and cleanup.** Re-run the full pipeline, confirm all 10 v1 acceptance criteria, delete the debug route.

**Estimated total effort:** 2.5–3 days (Harry is sole implementer with approximately 3 days remaining).

---

## Assumptions

1. OpenRouter's Gemini Pro supports the `{type: "file", file: {filename, file_data: "data:application/pdf;base64,..."}}` content block format for vision — this is documented in the project context. If it does not, fall back to base64-encoded PNG screenshots of each page rendered server-side (STORY-A2 notes this).
2. Tavily `advanced` search already returns a `content` field containing full page text (confirmed in `lib/search.ts` — the `content` field exists in `SearchResult` but is discarded downstream).
3. The ABB deck is ≤30 pages. Vision cost estimate is based on Gemini Pro at ~$0.002/page.
4. `insforge.database` insert/select syntax remains unchanged throughout — no DB migration is needed for epics A-D.
5. The contrarian agent does not need a new DB column: `model_used` is a free-text field and can hold any label. The "red-team finding" identity is expressed via `model_used = "sonnet-contrarian"` on the evidence node — no schema change.
6. EPIC-V2-E re-ingest will be triggered manually via `POST /api/ingest` with `force: true` added in STORY-A3 — it does not need a UI button.

---

## Open Questions / Clarifications Needed

**Q1 — Gemini vision quotas (Technical — Harry to verify before starting EPIC-V2-A).** OpenRouter passes PDF file blocks to Gemini Pro, but the project currently has no cold-path test of this route. Before writing STORY-A2, confirm: does a one-page PDF block arrive correctly at Gemini via OpenRouter? A five-minute smoke test (single `complete()` call with a page-sized base64 PNG or PDF block) will de-risk the entire epic. If it fails, the fallback is server-side page rasterisation using `canvas` or `@napi-rs/canvas` (adds a story, half a day).

**Q2 — Ingest endpoint timeout on Vercel (Technical).** `app/api/ingest/route.ts` already sets `maxDuration = 300`. A vision pass on every page of the deck adds sequential Gemini calls. On Vercel Hobby the hard limit is 60s; Pro is 300s. For a 25-page deck with ~1s/page Gemini latency, 25s total is well within budget. But if the deck is longer, or if Gemini is slow, this will hit the timeout. Confirm deck page count; if > 50 pages, vision calls should be parallelised in batches of 5.

**Q3 — Cut scope for contrarian pass (Product).** STORY-C1 targets the top-2 highest-confidence hypotheses. If time is short this can be narrowed to just H1 (market size) which is the most demo-relevant. Confirm whether 2 hypotheses or 1 is acceptable as the minimum viable demo.

---

## Epic Overview and Dependency Map

```
EPIC-V2-A (PDF vision)
    ↓
EPIC-V2-B (web depth)       ← independent of A, runs in parallel
    ↓                               ↓
EPIC-V2-C (contrarian)  ←──────────┘  (needs A + B landed so re-run is meaningful)
    ↓
EPIC-V2-D (UI surfacing)    ← can begin after C's model_used convention is set
    ↓
EPIC-V2-E (verify + cleanup) ← last, blocks on A + B + C + D
```

Parallelisation opportunity: A and B can be built concurrently since they touch different files. C must follow because it makes most sense to verify once the data pipeline is improved.

---

## EPIC-V2-A: PDF Vision Ingestion (ID: EPIC-V2-A)

**User value:** Page 8 of the ABB deck (OMDIA chart, 10.4% CAGR, $2.26B TAM, segment splits) surfaces as retrievable evidence under H1. SPEC.md §12 AC#10 passes.

**Dependencies:** None (self-contained extension to `lib/ingest.ts` and `app/api/ingest/route.ts`).

**Estimated total effort:** 1 day.

**Backwards compatibility:** `ingestPDF()` is extended with an optional `visionModel` param defaulting to `undefined` (no vision pass). Existing call sites in `app/api/ingest/route.ts` pass the param explicitly only after this epic; the function signature remains backwards-compatible. The force-reingest path adds a new query-string param to the existing `POST /api/ingest` endpoint; existing callers are unaffected.

---

### STORY-A1: Vision extraction helper in `lib/ingest.ts`

**Type:** Technical Story

**Statement:** As a developer, I need a function that takes a raw PDF buffer and page number and returns the vision-extracted text for that page, so that downstream ingest logic can merge it with text-extracted content.

**Acceptance Criteria:**
- [ ] `extractPageVision(pdfBuffer: Buffer, pageNumber: number, model: LLMModel): Promise<string>` is exported from `lib/ingest.ts`
- [ ] Sends the page as a base64-encoded `data:application/pdf;base64,...` file block to the specified model via `complete()` in `lib/llm-client.ts`
- [ ] Prompt instructs the model to extract all visible text, numbers, chart labels, legend items, and data point values from the page
- [ ] Returns the model's response as a plain string (no JSON parsing needed)
- [ ] Handles empty or error responses gracefully: if the model returns an empty string or throws, returns `""` and logs a warning (does not propagate the error to the caller)
- [ ] No new npm packages required

**Complexity:** Small (0.5 day)

**Dependencies:** None

**Demo risk:** Low — this is a pure library function with no UI surface.

**Cost estimate:** ~$0.002–0.005 per page call on Gemini Pro via OpenRouter. Full 25-page deck = ~$0.05–0.12 per ingest run. Well within the $0.50/deck target.

**Notes:** Use `MODELS.geminiPro` as the default model. The file block format is `{ type: "file", file: { filename: "page-N.pdf", file_data: "data:application/pdf;base64,..." } }`. OpenRouter's `complete()` wrapper currently takes `Message[]` with string content — you will need to pass the raw OpenAI client call directly for this multimodal block, or extend `complete()` to accept a `content: string | ContentBlock[]` shape. Do not rewrite `complete()` — add a sibling `completeMultimodal()` function alongside it in `lib/llm-client.ts` that accepts `OpenAI.Chat.ChatCompletionMessageParam[]` directly and shares the same client instance.

---

### STORY-A2: Merge vision output into `ingestPDF()` per page

**Type:** Technical Story

**Statement:** As a developer, I need `ingestPDF()` to optionally run the vision helper on each page and merge vision-extracted text with text-extracted content, so that chart data reaches the `content_extract` column and becomes retrievable.

**Acceptance Criteria:**
- [ ] `ingestPDF()` accepts a new optional param `enableVision?: boolean` (defaults to `false`)
- [ ] When `enableVision = true`, calls `extractPageVision()` for each page sequentially (not parallel, to avoid quota burst)
- [ ] Merged `content_extract` = `textContent + "\n\n[vision]\n" + visionContent` — the `[vision]` separator makes the source obvious in the modal
- [ ] Pages where vision returns `""` use text-only content (no separator added)
- [ ] If the merged content exceeds 8000 chars, truncate to 8000 (embedding model limit is well above this, but keeps DB row sizes sane)
- [ ] Embedding is computed on the merged string, not on text-only
- [ ] `IngestResult` return type gains an `visionPages: number` field counting pages where vision added content

**Complexity:** Small (0.5 day)

**Dependencies:** STORY-A1

**Demo risk:** Low. Existing non-vision path is unchanged (`enableVision` defaults to `false`).

**Cost estimate:** Same as STORY-A1 — the per-page Gemini cost. No extra LLM calls introduced here.

**Notes:** Sequential page processing (not `Promise.all`) keeps Gemini rate limits safe. For the demo deck (~25 pages) this adds ~25 seconds to ingest time — acceptable since ingest is not on the demo's critical click path.

---

### STORY-A3: Force-reingest path in `POST /api/ingest`

**Type:** Technical Story

**Statement:** As a developer, I need the ingest endpoint to accept a `force` flag that clears existing source rows for a case before re-running, so I can replace the text-only ingestion with the vision-augmented one without manual DB surgery.

**Acceptance Criteria:**
- [ ] `POST /api/ingest` accepts `{ caseId: string, force?: boolean, enableVision?: boolean }` in the JSON body
- [ ] When `force = true`, deletes all `sources` rows for the resolved `dbCaseId` where `type = 'pdf'` before calling `ingestPDF()` — this makes the idempotency check in `ingestPDF()` return 0 existing rows, triggering a full re-ingest
- [ ] `enableVision` is forwarded to `ingestPDF()` — when `true`, runs the vision pass
- [ ] Response includes `visionPages` from `IngestResult`
- [ ] When `force = false` (or omitted), behaviour is identical to current: idempotent skip if rows exist
- [ ] After force-reingest of `abb-rack-pdu-deck.pdf`, the `sources` row for page 8 has `content_extract` containing the string "10.4" and the string "OMDIA"

**Complexity:** Small (0.5 day)

**Dependencies:** STORY-A2

**Demo risk:** Medium — the `DELETE` on sources cascades via `evidence_sources`. Run force-reingest before re-running the pipeline, not after. If run after, evidence nodes will have dangling `evidence_sources` references. Sequence: `POST /api/ingest?force=true` → `POST /api/runs` (new run). Document this in the demo script.

**Cost estimate:** ~$0.05–0.12 per full-deck vision ingest (same as STORY-A1 estimate).

**Notes:** The delete query is `DELETE FROM sources WHERE case_id = $1 AND type = 'pdf'`. Do not delete web sources — they are not regenerated by this endpoint and would leave stale evidence-source linkages if removed. The debug route deletion (EPIC-V2-E) is a separate cleanup; do not conflate.

---

## EPIC-V2-B: Deeper Web Research (ID: EPIC-V2-B)

**User value:** Evidence rows carry verbatim quotes long enough to read in the source modal. The evidence count visible to the demo viewer increases materially, showing broader research coverage.

**Dependencies:** None (independent of EPIC-V2-A).

**Estimated total effort:** 0.5–1 day.

**Backwards compatibility:** `gatherWebEvidence()` in `agents/evidence/web-search.ts` is modified in-place. The `search()` function in `lib/search.ts` already returns a `content` field that is currently discarded — this story starts using it. The `SearchResult` type in `lib/search.ts` already has `content?: string` so no type changes needed there.

---

### STORY-B1: Pipe full Tavily content to scorer and bump result count

**Type:** Technical Story

**Statement:** As a developer, I need the web evidence agent to pass the full Tavily page content (not just the 280-char snippet) to the scoring LLM and search more results per leaf, so that scored findings have enough material to extract a meaningful verbatim quote.

**Acceptance Criteria:**
- [ ] `WEB_RESULTS_PER_LEAF` is changed from `3` to `6`
- [ ] The `body` field passed to `scoreEvidence()` items is `result.content?.slice(0, 3000) ?? result.snippet` — full content preferred, snippet fallback
- [ ] The `content_extract` stored in the `sources` row is `result.content?.slice(0, 3000) ?? result.snippet` (same — this is what the source modal renders)
- [ ] The `quote` field in `evidence_sources` is populated from `item.sourceQuote` (already the case) and is no longer capped at `snippet.slice(0, 280)` — the cap is removed from the fallback on line 113 of `web-search.ts`
- [ ] After a full run, total evidence rows of type `web` is ≥ 60 (vs ~42 currently; 11 sub-hypotheses × 6 results - deduplication allowance)
- [ ] No new npm packages

**Complexity:** Small (0.5 day)

**Dependencies:** None

**Demo risk:** Low. The change is additive — more text in, better quotes out. The click path is unaffected.

**Cost estimate:** Mistral scoring calls scale with input tokens. Going from 280 chars to 3000 chars per item ≈ 10× input tokens per scored batch. Mistral Medium at ~$0.40/M input tokens: 11 sub-hypotheses × 6 items × 3000 chars ≈ 198K chars ≈ 50K tokens ≈ $0.02 incremental per run. Negligible.

**Notes:** The only file to modify is `agents/evidence/web-search.ts`. Two constants change (`WEB_RESULTS_PER_LEAF`) and one inline expression changes (`result.snippet` → `result.content?.slice(0, 3000) ?? result.snippet`). The third change is removing the `.slice(0, 280)` cap on the fallback quote on line 113.

---

### STORY-B2: Multi-query expansion via Mistral

**Type:** Technical Story

**Statement:** As a developer, I need the web evidence agent to generate 2 query variants per sub-hypothesis using Mistral and run all queries, deduped by URL, so that evidence covers more angles than a single keyword query.

**Acceptance Criteria:**
- [ ] Before calling `search()`, `gatherWebEvidence()` calls a new helper `expandQueries(label: string, claim: string, subs: Record<string, string>): Promise<string[]>` that returns 2 variant query strings
- [ ] `expandQueries()` uses `completeAs('evidence-web', ...)` (Mistral) with a short prompt asking for 2 alternative search queries for the same hypothesis; returns the 2 variants plus the original buildQuery output (3 queries total)
- [ ] All 3 queries are run via `search()` with `maxResults = 4` each (12 raw results total per leaf)
- [ ] Results are deduped by exact URL match before scoring — a URL seen in multiple query results counts once
- [ ] After dedup, at most 6 items are passed to `scoreEvidence()` (take highest-scoring by Tavily `score` if > 6 survive dedup)
- [ ] Total evidence rows after a full run remains bounded at ≤ 80 (11 subs × 6 max after dedup + some hypothesis-level direct hits)

**Complexity:** Medium (1 day)

**Dependencies:** STORY-B1 (rely on the updated `WEB_RESULTS_PER_LEAF` and content-piping; must be built on the same file after B1 lands)

**Demo risk:** Low. The pipeline still uses `Promise.allSettled` — a Mistral query expansion failure falls back gracefully. Worst case: the original single query runs unchanged.

**Cost estimate:** 11 sub-hypotheses × 1 Mistral expansion call × ~200 tokens ≈ 2200 tokens ≈ $0.001 incremental. Tavily cost: 11 leaves × 3 queries × ~$0.015/search ≈ $0.50/run incremental. This is the dominant cost change in EPIC-V2-B. Total web cost per run goes from ~$0.17 to ~$0.67. Acceptable.

**Notes:** `expandQueries()` should be a private helper inside `web-search.ts`, not a separate file — keeps the module self-contained. The Mistral prompt should be short: "Given the hypothesis claim and company context, write 2 alternative web search queries (different angles, no repeating the exact phrase). Return JSON: { queries: [string, string] }". Use `completeJson` so it's parseable. If parse fails, return empty array and fall back to the single original query.

---

## EPIC-V2-C: Contrarian / Red-Team Pass (ID: EPIC-V2-C)

**User value:** The demo viewer can point at a specific "red-team finding" row with a distinctive badge and say "this is Agent Victor challenging its own conclusion, which is something no static deck does." Multi-model disagreement is a tangible, visible artefact.

**Dependencies:** EPIC-V2-A and EPIC-V2-B should be landed first so the contrarian pass runs against richer evidence. However, the contrarian stories are structurally independent — they can be built while A/B are being tested.

**Estimated total effort:** 1 day.

**Backwards compatibility:** `rollupConfidence()` in `agents/rollup.ts` is not modified. A new file `agents/contrarian.ts` is added. `agents/orchestrator.ts` gains a new stage between Stage 7 (persist rollup) and Stage 8 (decide) — this is an extension, not a rewrite. The `EvidenceList` component gains a conditional badge display for `model_used = "sonnet-contrarian"` nodes — the existing non-contrarian rows are visually unchanged.

---

### STORY-C1: Contrarian agent (`agents/contrarian.ts`)

**Type:** Technical Story

**Statement:** As a developer, I need a contrarian agent that reads the top-2 highest-confidence hypotheses after rollup and writes 1-2 counter-finding evidence children per hypothesis, so that the pipeline surfaces structured disagreement from a separate model role.

**Acceptance Criteria:**
- [ ] New file `agents/contrarian.ts` exports `runContrarianPass(caseId: string, hypotheses: TreeNode[]): Promise<TreeNode[]>`
- [ ] Selects the 2 hypotheses with the highest `confidence` value from the passed array (already rolled up)
- [ ] For each selected hypothesis, makes one Sonnet call with a prompt that: (a) states the hypothesis claim and its current confidence score, (b) lists the supporting evidence (fetch children where `type='evidence'` and `supports='for'` from DB), (c) asks "What is the strongest single counter-argument or disconfirming data point that a skeptic would raise?" and returns JSON `{ counterFinding: string, sourceQuote?: string }`
- [ ] Writes each counter-finding as a `tree_nodes` row with: `type='evidence'`, `parent_id = hypothesis.id` (not sub-hypothesis), `model_used = 'sonnet-contrarian'`, `status='complete'`, `content.supports = 'against'`, `content.strength = 'moderate'`, `content.finding = counterFinding`, `content.sourceQuote = sourceQuote ?? undefined`
- [ ] Also writes a `sources` row with `type='web'`, `title='Red-team analysis'`, `uri=''`, `content_extract = counterFinding` and links it via `evidence_sources`
- [ ] Function is wrapped in `try/catch` — any failure logs a warning and returns `[]` without crashing the run
- [ ] Returns the array of inserted `TreeNode` rows

**Complexity:** Medium (1 day)

**Dependencies:** STORY-C2 must follow (orchestrator wiring), but this story can be built standalone and tested by calling it directly.

**Demo risk:** Medium. Counter-finding nodes land on the hypothesis card (not sub-hypothesis), so they appear when the demo viewer clicks H1 or H2 and drills into its evidence. Verify that `EvidenceList` accepts evidence children of a hypothesis node (it currently renders children of a sub-hypothesis ID). STORY-C3 covers the UI badge; without C3, the rows still appear but without the red-team label.

**Cost estimate:** 2 hypotheses × 1 Sonnet call × ~1500 tokens input + 100 tokens output ≈ 3200 tokens per run. Sonnet at ~$3/M input: $0.01 per run. Negligible.

**Notes:** The Sonnet prompt should include the full hypothesis claim plus the top 3 supporting evidence findings (not full content — just the `finding` field from each `EvidenceContent`). This keeps the context tight and the counter-argument grounded. Do not pass all evidence to avoid token bloat.

---

### STORY-C2: Wire contrarian pass into orchestrator

**Type:** Technical Story

**Statement:** As a developer, I need the orchestrator to call `runContrarianPass()` after confidence rollup and before the decision agent, so the contrarian findings are written to the DB before Opus synthesises the final decision.

**Acceptance Criteria:**
- [ ] `agents/orchestrator.ts` imports `runContrarianPass` from `./contrarian`
- [ ] After Stage 7 (`persistHypothesisRollup`), a new Stage 7.5 calls `runContrarianPass(dbCaseId, rollup.tree.filter(n => n.type === 'hypothesis'))`
- [ ] The call is wrapped in `try/catch` — failure logs but does not set run status to `failed`
- [ ] The decision agent (Stage 8) is unmodified — Opus synthesises from whatever is in the DB at that point (which now includes contrarian rows)
- [ ] A full run completing with contrarian findings does not break the drill-down click path in any way

**Complexity:** Small (0.5 day)

**Dependencies:** STORY-C1

**Demo risk:** Low once STORY-C1 is stable. The `try/catch` wrapper means orchestrator never fails due to contrarian agent issues.

**Cost estimate:** No additional cost beyond STORY-C1's Sonnet calls.

**Notes:** The placement before `decide()` means Opus reads contrarian findings as part of the evidence landscape. This is intentional — the decision agent should factor in disagreement. No change to `decide.ts` is needed.

---

### STORY-C3: Red-team badge in `EvidenceList`

**Type:** User Story

**Statement:** As a demo viewer, I want contrarian evidence rows to be visually distinctive so that I can immediately identify that a different model challenged the hypothesis without reading the model tag.

**Acceptance Criteria:**
- [ ] In `components/EvidenceList.tsx`, when `item.node.model_used === 'sonnet-contrarian'`, a "red-team" badge is rendered — amber/orange colour, distinct from the existing For/Against/Mixed badges
- [ ] The badge label is "red team" (lowercase, consistent with existing badge style)
- [ ] The badge renders inside the existing badge row, before the `StrengthBadge`
- [ ] Non-contrarian rows render exactly as they do today
- [ ] The badge is visible at a glance from a laptop screen at arm's length (font size ≥ 10px, sufficient contrast)

**Complexity:** Small (0.5 day)

**Dependencies:** STORY-C1 (need to know the `model_used` value); STORY-C2 (need the rows to exist in the DB)

**Demo risk:** Low — purely additive UI change. Existing rows are not affected. The click path is unchanged.

**Cost estimate:** No LLM calls.

**Notes:** Suggested Tailwind classes for the badge: `bg-amber-500/15 text-amber-300 rounded-full px-2 py-0.5 text-[10px] font-medium`. This matches the visual weight of the existing `SupportsBadge` without being confused with "Against" (which is rose-coloured).

---

## EPIC-V2-D: UI Surfacing of Multi-Model (ID: EPIC-V2-D)

**User value:** A demo viewer looking at the decision card can see at a glance that 4-5 distinct models contributed to the run, without any verbal explanation from the presenter.

**Dependencies:** EPIC-V2-C (establishes the `sonnet-contrarian` model_used label convention, which is included in the footer).

**Estimated total effort:** 0.5 day.

**Backwards compatibility:** `KanbanBoard.tsx` is modified in-place. The `DecisionCard` component gains a footer section. The hardcoded "Master Decision · Opus" label is kept but supplemented. The evidence model badge in `EvidenceList.tsx` is resized — no functional change, only a CSS class update.

---

### STORY-D1: Models-used footer on the decision card

**Type:** User Story

**Statement:** As a demo viewer, I want to see which AI models contributed to the run at the bottom of the decision card, so that I can immediately understand that multiple models were involved without being told.

**Acceptance Criteria:**
- [ ] The `DecisionCard` component in `KanbanBoard.tsx` renders a "models used" footer below the `ConfidenceMeter`
- [ ] The footer aggregates `model_used` values from all `tree_nodes` for the run (the data is already fetched by `fetchRunNodes`)
- [ ] Each distinct model appears once, rendered as a small pill with the model shortname (using the existing `modelTag()` logic from `EvidenceList.tsx`) and a subtle colour-coded icon or dot (Opus = emerald, Sonnet = sky, Mistral = violet, Gemini = amber, sonnet-contrarian = amber with "red team" label)
- [ ] The footer label reads "models" (in the existing `text-[10px] uppercase tracking-widest text-neutral-500` style)
- [ ] The footer does not appear if only one distinct model is present (degenerate case)
- [ ] No new data fetch is required — `q.data` from `fetchRunNodes` already contains all nodes

**Complexity:** Small (0.5 day)

**Dependencies:** None (data is already available in `fetchRunNodes` response)

**Demo risk:** Low — additive UI only. The decision card still renders correctly even if the aggregation finds zero or one models.

**Cost estimate:** No LLM calls.

**Notes:** `modelTag()` is currently defined in `EvidenceList.tsx`. Extract it to a shared `lib/model-labels.ts` file so both `KanbanBoard.tsx` and `EvidenceList.tsx` can import it — avoids duplication. This is a one-function extraction with no risk.

---

### STORY-D2: Larger model badge on evidence rows

**Type:** User Story

**Statement:** As a demo viewer, I want the model badge on evidence rows to be legible at a glance, so that I can see "mistral" or "gemini" without squinting at 10px text.

**Acceptance Criteria:**
- [ ] In `components/EvidenceList.tsx`, the model tag `span` changes from `text-[10px]` to `text-xs` (12px) and from `rounded bg-neutral-900 px-1.5 py-0.5` to `rounded bg-neutral-800 px-2 py-0.5` — slightly more padding and a subtly lighter background for contrast
- [ ] The `text-neutral-500` colour is upgraded to `text-neutral-400` so it reads clearly against the card background
- [ ] All other badge positioning and layout is unchanged
- [ ] The change applies only to the model tag span; `SupportsBadge` and `StrengthBadge` are untouched

**Complexity:** Small (0.5 day — can be combined with D1 into a single coding session)

**Dependencies:** None

**Demo risk:** None — pure CSS class changes on a non-interactive element.

**Cost estimate:** No LLM calls.

**Notes:** This story is genuinely small. If time is very short it can be folded into STORY-D1 in the same file edit session.

---

## EPIC-V2-E: Verification and Cleanup (ID: EPIC-V2-E)

**User value:** The demo is verified end-to-end. The debug route is gone so the deployed app has no accidental data-exposure surface.

**Dependencies:** EPIC-V2-A, EPIC-V2-B, EPIC-V2-C, EPIC-V2-D all landed.

**Estimated total effort:** 0.5 day.

**Backwards compatibility:** The debug route deletion removes `app/api/debug/sources/route.ts`. No other file references this route — it was a diagnostic artefact. Confirm with `grep -r "debug/sources"` before deleting.

---

### STORY-E1: Re-run pipeline and verify all 10 acceptance criteria

**Type:** Technical Story

**Statement:** As Harry, I need to run the full pipeline against the ABB case post-v2 and manually verify all 10 acceptance criteria from SPEC.md §12, so that I can walk into the demo confident.

**Acceptance Criteria:**
- [ ] `POST /api/ingest` called with `{ caseId: "abb-rack-pdu", force: true, enableVision: true }` — response shows `visionPages > 0`
- [ ] Page 8 source row in DB has `content_extract` containing "10.4" and "OMDIA" — verified via DB inspector or a one-off query
- [ ] `POST /api/runs` starts a new run — pipeline completes without `status: 'failed'`
- [ ] All 10 criteria from SPEC.md §12 are verified manually (AC#10 = OMDIA chart under H1 is the most critical)
- [ ] Contrarian evidence row(s) are visible in the evidence list for H1 or H2 with the amber "red team" badge
- [ ] Decision card footer shows ≥ 4 distinct model pills
- [ ] Evidence rows on sub-hypothesis views show larger, legible model badges

**Complexity:** Small (0.5 day including fix time for minor issues)

**Dependencies:** All prior epics

**Demo risk:** This story IS the risk mitigation. If any AC fails here, there is still time to patch.

**Cost estimate:** One full pipeline run: ~$1.50–3.00 (Gemini vision ingest + expanded Tavily searches + Sonnet evaluation × 11 subs + Sonnet contrarian × 2 + Opus decision). Run against live ABB case, not a test fixture.

**Notes:** Run the pipeline at least twice if time allows — the second run validates idempotency of the non-force ingest path (should skip all PDF rows) and confirms evidence counts are stable.

---

### STORY-E2: Delete `app/api/debug/sources/route.ts`

**Type:** Technical Story

**Statement:** As Harry, I need to remove the diagnostic debug route so the deployed app does not expose raw source data to anyone with the URL.

**Acceptance Criteria:**
- [ ] `app/api/debug/sources/route.ts` is deleted
- [ ] `grep -r "debug/sources"` returns zero hits in `app/`, `lib/`, `agents/`, `components/`
- [ ] The Next.js build (`next build`) completes without errors after the deletion
- [ ] The drill-down click path is unaffected (this route was not referenced by any client component)

**Complexity:** Small (0.25 day — trivial but explicit so it doesn't get forgotten)

**Dependencies:** STORY-E1 (run verification first in case the debug route is still needed for debugging)

**Demo risk:** None — the route is not part of the demo click path.

**Cost estimate:** No LLM calls.

---

## Recommended Execution Order

Day 1 (today):

1. **STORY-A1** — vision helper in `lib/ingest.ts` + `lib/llm-client.ts` `completeMultimodal()` extension
2. **STORY-B1** — content piping + result count bump in `web-search.ts` (independent, can be done in a separate editor tab while waiting for A1 smoke test)
3. **STORY-A2** — merge vision into `ingestPDF()`
4. **STORY-A3** — force-reingest path in the ingest endpoint

Day 2:

5. **STORY-B2** — multi-query expansion via Mistral
6. **STORY-C1** — contrarian agent in `agents/contrarian.ts`
7. **STORY-C2** — wire into orchestrator
8. **STORY-D1** and **STORY-D2** — model footer + badge resize (can be one coding session; extract `lib/model-labels.ts` first)

Day 3 (demo prep):

9. **STORY-C3** — red-team badge in EvidenceList
10. **STORY-E1** — full pipeline re-run + verification of all 10 ACs
11. **STORY-E2** — delete debug route

Parallelisation notes: A1 and B1 touch completely different files and can be built simultaneously. A2 depends on A1. C1 and B2 can be built in parallel (different files). C2 depends on C1. D1 and D2 can be one coding session on the same day as C2.

---

## Stories to Drop if Time Runs Short

Cut in this order — each item below it is higher value or lower risk:

| Priority | Story to drop | What you lose | Safe to drop? |
|---|---|---|---|
| Drop first | **STORY-D2** (badge resize) | Evidence model badges stay tiny | Yes — cosmetic only |
| Drop second | **STORY-B2** (multi-query expansion) | Evidence count stays at ~66 instead of ~80; quote quality already improved by B1 | Yes — B1 alone is a solid improvement |
| Drop third | **STORY-C3** (red-team badge) | Contrarian rows appear but lack the amber "red team" label; they still show `supports='against'` | Marginal — the demo story is weaker without it |
| Drop fourth | **STORY-C1 + C2 + C3** (entire contrarian pass) | No visible multi-model disagreement; demo relies on model pills (D1) for the multi-model story | Acceptable if time is truly short — the drill-down still works |
| Do not drop | **STORY-A1 + A2 + A3** | AC#10 fails — OMDIA chart never surfaces | No — this is a demo non-negotiable |
| Do not drop | **STORY-B1** | Source quotes remain 280 chars; modal content is thin | No — easy win, half a day |
| Do not drop | **STORY-D1** | Decision card has no model attribution footer | No — this is the primary multi-model visibility fix |
| Do not drop | **STORY-E1** | No verified demo | No — always run before the demo |
| Do not drop | **STORY-E2** | Debug route stays live | Low severity, but drop last |

---

*End of plan-v2.md. Harry executes; do not auto-run.*
