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

// ─── Content payloads (SPEC §5.2) ────────────────────────────────────────────

export interface DecisionContent {
  finalDecision: string;
  reasoning: string;
  weakestLinkNodeId: string;
  thresholdsMet: Record<string, boolean>;
}

export interface HypothesisContent {
  claim: string;
  templateId?: string;
  rationale?: string;
}

export interface EvidenceContent {
  finding: string;
  supports: EvidenceSupports;
  strength: EvidenceStrength;
  sourceQuote?: string;
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
