// Pure type module — no runtime imports.
// Mirrors the InsForge schema (SPEC §5.1) and content payload shapes (SPEC §5.2).
// Field names are snake_case to match what the InsForge SDK returns from postgres.

// ─── Enums ───────────────────────────────────────────────────────────────────

export type TreeNodeType =
  | "decision"
  | "hypothesis"
  | "sub_hypothesis"
  | "evidence"
  | "question";

export type TreeNodeStatus = "pending" | "running" | "complete" | "failed";

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "complete"
  | "failed";

export type SourceType = "web" | "pdf" | "docx" | "user_input";

export type QuestionType = "yes_no" | "yes_no_context" | "open";

export type EvidenceSupports = "for" | "against" | "mixed";

export type EvidenceStrength = "weak" | "moderate" | "strong";

/** Bias of the source the evidence came from. (improve.md §5.)
 *
 *  - `third-party` — neutral source (web by default)
 *  - `neutral-advocate` — author of the analysis (Innovera brief); no
 *    financial interest in outcome → no adjustment applied
 *  - `pre-disposed-favourable` — author benefits from a yes (ABB deck);
 *    supportive findings demoted one step, surprising findings promoted
 *  - `pre-disposed-against` — author benefits from a no; mirror rule
 */
export type SourceStake =
  | "third-party"
  | "neutral-advocate"
  | "pre-disposed-favourable"
  | "pre-disposed-against";

// ─── Content payloads (SPEC §5.2) ────────────────────────────────────────────

export type ThresholdStatus =
  | "met"
  | "not-met"
  | "not-directly-tested"
  | "partially-tested";

export interface ThresholdRecord {
  target: number | string;
  observed: number | string | null;
  status: ThresholdStatus;
  /** Tree-node ids of the sub-hypotheses that should test this threshold. */
  sourceLeafIds: string[];
}

export type ConsideredAlternativeType =
  | "hypothesis"
  | "method"
  | "scope"
  | "framework";

export interface ConsideredAlternative {
  type: ConsideredAlternativeType;
  name: string;
  whyCut: string;
}

/** The three discrete decision states. NO `pursue-with-conditions` —
 *  explicitly banned product decision (2026-05-06): the system must commit
 *  or admit uncertainty, not soften a recommendation. */
export type FinalDecisionState =
  | "pursue"
  | "do-not-pursue"
  | "insufficient-evidence";

export type Tier2Option = "build" | "buy" | "partner";

export interface Tier2Snapshot {
  recommendedOption: Tier2Option;
  rationale: string;
}

export interface DecisionContent {
  /** Free-form headline (e.g. "Pursue rack PDU via acquisition"). */
  finalDecision: string;
  /** Discrete state for state-aware UI and downstream tooling. v3+ runs
   *  populate this; pre-v3 runs may leave it undefined. (improve.md §7.) */
  finalDecisionState?: FinalDecisionState;
  reasoning: string;
  weakestLinkNodeId: string;
  /** Hypothesis label resolved at decision time. Renderers should prefer this
   *  over weakestLinkNodeId for human-facing callouts. (improve.md §6.) */
  weakestLinkLabel?: string;
  /** Per-threshold record: target, observed value (or status), source leaves.
   *  Renderers should prefer this over thresholdsMet. (improve.md §10.) */
  thresholds?: Record<string, ThresholdRecord>;
  /** @deprecated retained for backwards compat with pre-v3 runs. */
  thresholdsMet: Record<string, boolean>;
  /** Alternatives the decision agent seriously weighed, retained for Micky. */
  consideredAlternatives?: ConsideredAlternative[];
  /** Tier 2 result snapshot, present only when the gate fired. */
  tier2?: Tier2Snapshot;
}

export type HypothesisTestType = 'threshold' | 'comparison' | 'scenario' | 'binary';

export interface HypothesisTest {
  type: HypothesisTestType;
  metric: string;
  target: string | number;
  horizon?: string;
}

/** Whether a hypothesis's truth depends on the entry mode (build / buy /
 *  partner) chosen at Tier 2. (improve.md §9.)
 *
 *  - `agnostic` — claim is true or false regardless of mode
 *  - `build-only` — only meaningful when ABB builds the product itself
 *  - `build-or-partner` — relevant when building or partnering, not when buying
 *  - `buy-or-partner` — relevant when buying or partnering, not when building
 *  - `mode-conditional` — the answer differs sharply across modes
 *  - `requires_mode` — legacy alias retained for pre-v3 data; treat as
 *    mode-conditional in new code
 */
export type ModeDependence =
  | 'agnostic'
  | 'build-only'
  | 'build-or-partner'
  | 'buy-or-partner'
  | 'mode-conditional'
  | 'requires_mode';

export interface HypothesisContent {
  claim: string;
  /** Short noun-phrase label for partner-facing surfaces. Full claims remain
   *  in `claim` for evidence linkage and falsifier displays. */
  displayLabel?: string;
  falsifier: string;
  test: HypothesisTest;
  modeDependence: ModeDependence;
  insightAtStake: string;
  templateId?: string;
  rationale?: string;
  /** Single-sentence prescription describing what evidence would close the
   *  diligence gap. Populated by the evaluator only when confidence < 0.5.
   *  (improve.md §8.) */
  gapClosingAction?: string;
  /** Rejected decomposition options retained for Micky's partner memo. */
  consideredAlternatives?: ConsideredAlternative[];
}

export interface EvidenceContent {
  finding: string;
  supports: EvidenceSupports;
  /** Strength after stake adjustment (improve.md §5). The pre-adjustment
   *  score is preserved in `rawStrength` for transparency. */
  strength: EvidenceStrength;
  sourceQuote?: string;
  /** Bias of the originating source. Set at scoring time. */
  sourceStake?: SourceStake;
  /** Pre-stake-adjustment strength as scored by the LLM. Present only when
   *  the stake adjustment changed the strength. */
  rawStrength?: EvidenceStrength;
}

export interface QuestionContent {
  question: string;
  type: QuestionType;
  options?: string[];
  needed_because: string;
}

// ─── tree_nodes (discriminated on `type`) ────────────────────────────────────

interface TreeNodeBase {
  id: string;
  case_id: string;
  parent_id: string | null;
  label: string;
  confidence: number | null;
  evidence_strength: number;
  weight: number | null;
  scenario_id: string | null;
  model_used: string | null;
  status: TreeNodeStatus;
  created_at: string;
  updated_at: string;
}

export type TreeNode =
  | (TreeNodeBase & { type: "decision"; content: DecisionContent })
  | (TreeNodeBase & { type: "hypothesis"; content: HypothesisContent })
  | (TreeNodeBase & { type: "sub_hypothesis"; content: HypothesisContent })
  | (TreeNodeBase & { type: "evidence"; content: EvidenceContent })
  | (TreeNodeBase & { type: "question"; content: QuestionContent });

// Convenience aliases for callers that only handle one node type.
export type DecisionNode = Extract<TreeNode, { type: "decision" }>;
export type HypothesisNode = Extract<
  TreeNode,
  { type: "hypothesis" | "sub_hypothesis" }
>;
export type EvidenceNode = Extract<TreeNode, { type: "evidence" }>;
export type QuestionNode = Extract<TreeNode, { type: "question" }>;

// ─── cases ───────────────────────────────────────────────────────────────────

export interface Case {
  id: string;
  title: string;
  question: string;
  framework_id: string;
  weights: Record<string, number>;
  thresholds: Record<string, number | string>;
  brief_extract: ParsedBrief | null;
  created_at: string;
}

// Brief Parser output (SPEC §6.1 — stored on cases.brief_extract)
export interface ParsedBrief {
  thresholds: Record<string, number | string>;
  constraints: string[];
  weights: Record<string, number>;
  infoGaps: string[];
  risks: { description: string; likelihood: string; impact: string }[];
  stakeholderQuestions: string[];
  documentProvenance: { sourceId: string; author?: string; stake?: string }[];
  /** Brief-framing alternatives retained for Micky. */
  consideredAlternatives?: ConsideredAlternative[];
  /** Framework-selection alternatives retained for Micky. */
  consideredFrameworks?: ConsideredAlternative[];
}

// ─── sources ─────────────────────────────────────────────────────────────────

export interface SourceMetadata {
  pageNumber?: number;
  author?: string;
  stake?: string;
  ingestionDate?: string;
  [key: string]: unknown;
}

export interface Source {
  id: string;
  case_id: string;
  type: SourceType;
  uri: string | null;
  title: string | null;
  content_extract: string | null;
  // pgvector returns the embedding either as a number[] or as a stringified
  // array depending on driver — callers that need it should narrow.
  embedding: number[] | string | null;
  metadata: SourceMetadata | null;
  created_at: string;
}

// ─── evidence_sources ────────────────────────────────────────────────────────

export interface EvidenceSourceLink {
  evidence_node_id: string;
  source_id: string;
  quote: string | null;
  page_number: number | null;
}

// ─── user_questions (v2 table — kept for parity, never written in v1) ───────

export interface UserQuestion {
  id: string;
  case_id: string;
  question: string;
  question_type: QuestionType;
  options: string[] | null;
  affects_node_ids: string[];
  answer: string | null;
  answered_at: string | null;
  created_at: string;
}

// ─── runs ────────────────────────────────────────────────────────────────────

export interface Run {
  id: string;
  case_id: string;
  scenario_id: string | null;
  status: RunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

// ─── micky_runs ─────────────────────────────────────────────────────────────

export type MickyRunStatus = "pending" | "running" | "complete" | "failed";

export interface MickyReframe {
  headline: string;
  reasoning: string;
}

export interface MickyOutput {
  reframe: MickyReframe | null;
  recommendation: {
    oneLiner: string;
    weakestLink: string;
    whatWouldFlipIt: string;
  };
  frameworkRationale: {
    chosen: string;
    rejected: ConsideredAlternative[];
  };
  hypothesisRanking: {
    hypothesisId: string;
    hypothesisLabel: string;
    rank: number;
    rationale: string;
  }[];
  hypothesisDecomposition: {
    hypothesisId: string;
    hypothesisLabel: string;
    rationale: string;
    whatWasCut: ConsideredAlternative[];
  }[];
  judgmentCalls: {
    area: string;
    thinness: string;
    whyIWentThere: string;
  }[];
  pushback: { challenge: string }[];
  signOff: { date: string; monogram: "MB" };
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
  deleted_at: string | null;
}
