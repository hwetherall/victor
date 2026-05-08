"use client";

// Overview surface: a left-to-right issue tree table.
// The filename is retained so CaseView can keep its existing import boundary.

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { fetchMickyRuns, fetchRunNodes } from "@/lib/api-client";
import { aggregateModels, type ModelMeta } from "@/lib/model-labels";
import { ConfidenceMeter } from "./ConfidenceMeter";
import type {
  DecisionNode,
  FinalDecisionState,
  HypothesisContent,
  HypothesisNode,
  LeafRuntime,
  ThresholdRecord,
  ThresholdStatus,
  TreeNode,
} from "@/lib/schema";

/** Small "v1" / "v2" pill rendered in the issue-tree header (STORY-003). */
function LeafRuntimeBadge({ runtime }: { runtime: LeafRuntime }) {
  const isV2 = runtime === "v2";
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-semibold uppercase tracking-wide ${
        isV2 ? "bg-emerald-950 text-emerald-300" : "bg-neutral-800 text-neutral-400"
      }`}
      title={isV2 ? "Managed Agents leaf runtime" : "Legacy prompt-chain leaf runtime"}
    >
      {runtime}
    </span>
  );
}

interface KanbanBoardProps {
  caseConfigId: string;
  /** Canonical question from the case YAML. The decision card surfaces this
   *  rather than the rolled-up answer, so the kanban reads as "here is what
   *  we're asking and the evidence we gathered" instead of front-loading a
   *  conclusion. The DecisionDetail panel below still shows the answer. */
  caseQuestion: string;
  /** Fallback partner-facing label per slot `templateId` (sourced from the
   *  framework YAML at request time). Used when `content.displayLabel` is
   *  missing from a cached node — otherwise the panel would have to fall
   *  back to the long substituted claim. */
  displayLabelByTemplateId: Record<string, string>;
  runId: string;
  onSelectHypothesis: (hypothesisId: string) => void;
  onSelectSubHypothesis: (subId: string, parentHypothesisId: string) => void;
}

interface IssueBranch {
  hypothesis: HypothesisNode;
  subs: TreeNode[];
  evidenceCount: number;
}

interface GapGroup {
  parentLabel: string;
  actions: string[];
}

type TreeNodeRole = "decision" | "hypothesis" | "sub_hypothesis";

export function KanbanBoard({
  caseConfigId,
  caseQuestion,
  displayLabelByTemplateId,
  runId,
  onSelectHypothesis,
  onSelectSubHypothesis,
}: KanbanBoardProps) {
  const q = useQuery({
    queryKey: ["run-nodes", runId],
    queryFn: () => fetchRunNodes(runId),
  });
  const mickyRuns = useQuery({
    queryKey: ["micky-runs", runId],
    queryFn: () => fetchMickyRuns(runId),
  });

  if (q.isLoading) {
    return <p className="text-sm text-neutral-400">Loading tree...</p>;
  }
  if (q.isError) {
    return (
      <p className="text-sm text-rose-400">
        Failed to load tree: {(q.error as Error).message}
      </p>
    );
  }
  if (!q.data) return null;

  const decision = q.data.byType.decision[0] as DecisionNode | undefined;
  const hypotheses = q.data.byType.hypothesis as HypothesisNode[];
  const subByParent = groupByParent(q.data.byType.sub_hypothesis);
  const evByParent = groupByParent(q.data.byType.evidence);
  const sortedTier1 = decision
    ? hypotheses.filter((h) => h.parent_id === decision.id).sort(byLabel)
    : [...hypotheses].sort(byLabel);
  const branches: IssueBranch[] = sortedTier1.map((hypothesis) => {
    const subs = (subByParent.get(hypothesis.id) ?? []).sort(byLabel);
    return {
      hypothesis,
      subs,
      evidenceCount: countEvidenceUnder(hypothesis, subByParent, evByParent),
    };
  });
  const weakestId = decision?.content.weakestLinkNodeId ?? null;
  const modelsUsed = aggregateModels(q.data.nodes.map((n) => n.model_used));
  const hasMickyRun = (mickyRuns.data ?? []).some(
    (run) => run.status === "complete",
  );
  const labelByNodeId = new Map(q.data.nodes.map((n) => [n.id, n.label]));
  const gapList = aggregateGapList(
    q.data.byType.sub_hypothesis,
    sortedTier1,
    subByParent,
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">
              Issue tree
            </h2>
            <p className="mt-1 flex items-center gap-2 font-mono text-xs text-neutral-500">
              <span>
                {branches.length} hypotheses / {q.data.byType.sub_hypothesis.length} sub-hypotheses
              </span>
              <LeafRuntimeBadge runtime={q.data.run.leaf_runtime} />
            </p>
          </div>
          {hasMickyRun && (
            <Link
              href={`/case/${caseConfigId}/memo`}
              className="text-sm font-medium text-emerald-300 hover:text-emerald-200"
            >
              View Micky&apos;s memo -&gt;
            </Link>
          )}
        </div>

        {decision ? (
          <IssueTreeTable
            decision={decision}
            caseQuestion={caseQuestion}
            displayLabelByTemplateId={displayLabelByTemplateId}
            branches={branches}
            evByParent={evByParent}
            weakestId={weakestId}
            onSelectHypothesis={onSelectHypothesis}
            onSelectSubHypothesis={onSelectSubHypothesis}
          />
        ) : (
          <p className="px-4 py-5 text-sm text-neutral-500">
            No decision node found for this run.
          </p>
        )}
      </section>

      {decision && (
        <DecisionDetail
          node={decision}
          modelsUsed={modelsUsed}
          labelByNodeId={labelByNodeId}
          gapList={gapList}
        />
      )}

      {weakestId && (
        <WeakestLinkStrip nodes={q.data.nodes} weakestId={weakestId} />
      )}
    </div>
  );
}

function IssueTreeTable({
  decision,
  caseQuestion,
  displayLabelByTemplateId,
  branches,
  evByParent,
  weakestId,
  onSelectHypothesis,
  onSelectSubHypothesis,
}: {
  decision: DecisionNode;
  caseQuestion: string;
  displayLabelByTemplateId: Record<string, string>;
  branches: IssueBranch[];
  evByParent: Map<string, TreeNode[]>;
  weakestId: string | null;
  onSelectHypothesis: (hypothesisId: string) => void;
  onSelectSubHypothesis: (subId: string, parentHypothesisId: string) => void;
}) {
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[1280px] p-4">
        <div className="grid grid-cols-[320px_1fr] gap-x-8">
          <div className="relative">
            <div className="sticky top-4">
              <TreeNodePanel
                node={decision}
                role="decision"
                isWeakest={false}
                meta={`${Math.round((decision.confidence ?? 0) * 100)}% confidence`}
                titleOverride={caseQuestion}
                hideBody
              />
            </div>
          </div>

          <div className="relative flex flex-col gap-5 border-l border-neutral-800 pl-8">
            {branches.map((branch) => (
              <div
                key={branch.hypothesis.id}
                className="relative grid grid-cols-[340px_1fr] gap-x-8"
              >
                <span className="absolute -left-8 top-1/2 h-px w-8 bg-neutral-700" />
                <button
                  type="button"
                  onClick={() => onSelectHypothesis(branch.hypothesis.id)}
                  className="text-left"
                >
                  <TreeNodePanel
                    node={branch.hypothesis}
                    role="hypothesis"
                    isWeakest={branch.hypothesis.id === weakestId}
                    meta={`${branch.subs.length} sub / ${branch.evidenceCount} evidence`}
                    displayLabelByTemplateId={displayLabelByTemplateId}
                  />
                </button>

                <div className="relative flex flex-col gap-3 border-l border-neutral-800 pl-8">
                  {branch.subs.length === 0 ? (
                    <div className="rounded border border-dashed border-neutral-800 px-3 py-2 text-xs text-neutral-500">
                      No sub-hypotheses
                    </div>
                  ) : (
                    branch.subs.map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        onClick={() =>
                          onSelectSubHypothesis(sub.id, branch.hypothesis.id)
                        }
                        className="relative text-left"
                      >
                        <span className="absolute -left-8 top-1/2 h-px w-8 bg-neutral-700" />
                        <TreeNodePanel
                          node={sub}
                          role="sub_hypothesis"
                          isWeakest={sub.id === weakestId}
                          meta={`${evByParent.get(sub.id)?.length ?? 0} evidence`}
                          displayLabelByTemplateId={displayLabelByTemplateId}
                        />
                      </button>
                    ))
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeNodePanel({
  node,
  role,
  isWeakest,
  meta,
  titleOverride,
  hideBody,
  displayLabelByTemplateId,
}: {
  node: TreeNode;
  role: TreeNodeRole;
  isWeakest: boolean;
  meta: string;
  /** Caller-supplied title that wins over node-derived text. Used by the
   *  decision card to surface the case question instead of the rolled-up
   *  finalDecision. */
  titleOverride?: string;
  /** Suppress the body paragraph entirely. The decision card uses this so the
   *  panel reads as a question header, not a verdict + reasoning. */
  hideBody?: boolean;
  /** Optional `templateId → displayLabel` map sourced from the framework YAML.
   *  Lets us recover the partner-facing short label even for cached runs whose
   *  node content was written before displayLabels were added to the YAML. */
  displayLabelByTemplateId?: Record<string, string>;
}) {
  const content = node.content as Partial<HypothesisContent>;
  // Resolve a short display label, preferring (in order):
  //   1. value baked onto the cached node content
  //   2. lookup via the node's templateId in the loaded framework
  // This second hop is what rescues old runs from the framework rename without
  // requiring a re-run.
  const resolvedDisplayLabel =
    content.displayLabel ??
    (content.templateId
      ? displayLabelByTemplateId?.[content.templateId]
      : undefined);
  // `node.label` is hard-truncated to 60 chars in tree-builder.ts (it's a DB
  // index field, not a display field). Always prefer the full claim/displayLabel
  // for the headline so users never see a "…"-suffixed title.
  const derivedTitle =
    role === "decision"
      ? (node as DecisionNode).content.finalDecision || node.label
      : resolvedDisplayLabel || content.claim || node.label;
  const title = titleOverride ?? derivedTitle;
  // Only render claim as body when it would add information beyond the title
  // (i.e. we have a distinct short displayLabel). For cached runs without
  // displayLabel, the claim already IS the title, so showing it again is noise.
  const body = hideBody
    ? undefined
    : role === "decision"
      ? (node as DecisionNode).content.reasoning
      : resolvedDisplayLabel
        ? content.claim
        : undefined;
  const tone = nodeTone(node.confidence, role, isWeakest);

  return (
    <div
      className={`min-h-[124px] rounded-lg border p-4 transition-colors ${tone.shell}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className={`text-[10px] font-medium uppercase tracking-wider ${tone.label}`}>
          {roleLabel(role)}
        </span>
        {isWeakest && (
          <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium text-rose-300">
            weakest
          </span>
        )}
      </div>
      <p className="text-sm font-semibold leading-snug text-neutral-100">
        {title}
      </p>
      {body && (
        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-neutral-400">
          {body}
        </p>
      )}
      {role !== "decision" && (
        <div className="mt-3">
          <ConfidenceMeter value={node.confidence} size="sm" />
        </div>
      )}
      <div className="mt-3 font-mono text-[11px] text-neutral-500">{meta}</div>
    </div>
  );
}

function nodeTone(
  confidence: number | null,
  role: TreeNodeRole,
  isWeakest: boolean,
): { shell: string; label: string } {
  if (isWeakest) {
    return {
      shell: "border-rose-500/70 bg-rose-950/20 hover:border-rose-400",
      label: "text-rose-300",
    };
  }
  if (role === "decision") {
    return {
      shell: "border-sky-700/40 bg-sky-950/20",
      label: "text-sky-300",
    };
  }
  if (confidence === null) {
    return {
      shell: "border-neutral-800 bg-neutral-950 hover:border-neutral-600",
      label: "text-neutral-500",
    };
  }
  if (confidence >= 0.7) {
    return {
      shell: "border-emerald-700/50 bg-emerald-950/15 hover:border-emerald-500",
      label: "text-emerald-300",
    };
  }
  if (confidence >= 0.4) {
    return {
      shell: "border-amber-700/50 bg-amber-950/15 hover:border-amber-500",
      label: "text-amber-300",
    };
  }
  return {
    shell: "border-rose-800/50 bg-rose-950/15 hover:border-rose-500",
    label: "text-rose-300",
  };
}

function roleLabel(role: TreeNodeRole): string {
  // The decision card in the issue tree now frames the case question rather
  // than the rolled-up answer; the verdict still appears in DecisionDetail
  // below. The eyebrow reflects that framing.
  if (role === "decision") return "Question";
  if (role === "hypothesis") return "Hypothesis";
  return "Sub-hypothesis";
}

function DecisionDetail({
  node,
  modelsUsed,
  labelByNodeId,
  gapList,
}: {
  node: DecisionNode;
  modelsUsed: ModelMeta[];
  labelByNodeId: Map<string, string>;
  gapList: GapGroup[];
}) {
  const content = node.content;
  const thresholdEntries = Object.entries(content.thresholds ?? {});
  const metCount = thresholdEntries.filter(
    ([, r]) => r.status === "met",
  ).length;
  const totalThresholds =
    thresholdEntries.length || Object.keys(content.thresholdsMet ?? {}).length;
  const palette = decisionPalette(content.finalDecisionState);

  return (
    <section className={`rounded-lg border ${palette.border} ${palette.bg} p-5`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className={`text-[10px] uppercase tracking-widest ${palette.label}`}>
            {palette.eyebrow}
          </span>
          <h3 className="mt-2 text-lg font-semibold text-neutral-50">
            {content.finalDecision || "Decision pending"}
          </h3>
        </div>
        <span className="font-mono text-xs text-neutral-400">
          thresholds {metCount}/{totalThresholds} met
        </span>
      </div>
      <div className="mt-4 max-w-md">
        <ConfidenceMeter value={node.confidence} />
      </div>
      {thresholdEntries.length > 0 && (
        <ThresholdsBlock
          entries={thresholdEntries}
          labelByNodeId={labelByNodeId}
        />
      )}
      {gapList.length > 0 && <GapList groups={gapList} />}
      {modelsUsed.length > 1 && <ModelList modelsUsed={modelsUsed} />}
    </section>
  );
}

interface DecisionPalette {
  border: string;
  bg: string;
  label: string;
  eyebrow: string;
}

function decisionPalette(state: FinalDecisionState | undefined): DecisionPalette {
  switch (state) {
    case "pursue":
      return {
        border: "border-emerald-700/40",
        bg: "bg-emerald-950/20",
        label: "text-emerald-400",
        eyebrow: "Master decision - pursue",
      };
    case "do-not-pursue":
      return {
        border: "border-rose-700/40",
        bg: "bg-rose-950/20",
        label: "text-rose-400",
        eyebrow: "Master decision - do not pursue",
      };
    case "insufficient-evidence":
      return {
        border: "border-amber-700/40",
        bg: "bg-amber-950/20",
        label: "text-amber-400",
        eyebrow: "Master decision - insufficient evidence",
      };
    default:
      return {
        border: "border-neutral-800",
        bg: "bg-neutral-950",
        label: "text-neutral-500",
        eyebrow: "Master decision",
      };
  }
}

function WeakestLinkStrip({
  nodes,
  weakestId,
}: {
  nodes: TreeNode[];
  weakestId: string;
}) {
  const weakest = nodes.find((n) => n.id === weakestId);
  if (!weakest) return null;
  return (
    <section className="rounded-lg border border-rose-800/50 bg-rose-950/15 px-4 py-3">
      <span className="text-[10px] font-medium uppercase tracking-widest text-rose-300">
        Weakest link
      </span>
      <p className="mt-1 text-sm text-neutral-200">{weakest.label}</p>
    </section>
  );
}

function GapList({ groups }: { groups: GapGroup[] }) {
  return (
    <div className="mt-5 border-t border-neutral-800/80 pt-3">
      <span className="text-[10px] uppercase tracking-widest text-amber-400">
        Diligence gaps to close
      </span>
      <ul className="mt-2 grid gap-2 text-xs md:grid-cols-2">
        {groups.map((g) => (
          <li key={g.parentLabel} className="leading-relaxed">
            <div className="text-neutral-400">{g.parentLabel}</div>
            <div className="mt-1 text-amber-200">{g.actions.join(" ")}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ThresholdsBlock({
  entries,
  labelByNodeId,
}: {
  entries: [string, ThresholdRecord][];
  labelByNodeId: Map<string, string>;
}) {
  return (
    <div className="mt-5 border-t border-neutral-800/80 pt-3">
      <span className="text-[10px] uppercase tracking-widest text-neutral-500">
        Thresholds
      </span>
      <ul className="mt-2 space-y-1.5 text-xs">
        {entries.map(([key, record]) => {
          const sourceLabels = record.sourceLeafIds
            .map((id) => labelByNodeId.get(id))
            .filter((l): l is string => Boolean(l));
          return (
            <li key={key} className="font-mono">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-neutral-400">{key}</span>
                <span className="text-neutral-300">
                  <span className="text-neutral-500">target </span>
                  {String(record.target)}
                  <span className="mx-1.5 text-neutral-700">/</span>
                  <span className="text-neutral-500">observed </span>
                  <span className={statusClass(record.status)}>
                    {formatObserved(record)}
                  </span>
                </span>
              </div>
              {sourceLabels.length > 0 && (
                <div className="mt-0.5 pl-2 text-[10px] text-neutral-500">
                  see {sourceLabels.join("; ")}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ModelList({ modelsUsed }: { modelsUsed: ModelMeta[] }) {
  return (
    <div className="mt-5 border-t border-neutral-800/80 pt-3">
      <span className="text-[10px] uppercase tracking-widest text-neutral-500">
        Models contributing to this run
      </span>
      <div className="mt-2 flex flex-wrap gap-2">
        {modelsUsed.map((m) => (
          <span
            key={`${m.label}-${m.badge ?? ""}`}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${m.bgClass} ${m.textClass}`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current" />
            <span className="uppercase tracking-wider">{m.label}</span>
            {m.badge && (
              <span className="text-[10px] opacity-90">- {m.badge}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

function aggregateGapList(
  subs: TreeNode[],
  tier1: HypothesisNode[],
  subByParent: Map<string, TreeNode[]>,
): GapGroup[] {
  const subToParent = new Map<string, string>();
  for (const parent of tier1) {
    for (const child of subByParent.get(parent.id) ?? []) {
      subToParent.set(child.id, parent.id);
    }
  }
  const parentLabelById = new Map(tier1.map((p) => [p.id, p.label]));

  const groups = new Map<string, GapGroup>();
  for (const s of subs) {
    const action = (s.content as HypothesisContent).gapClosingAction;
    if (!action) continue;
    const parentId = subToParent.get(s.id);
    if (!parentId) continue;
    const parentLabel = parentLabelById.get(parentId) ?? "(unknown)";
    const existing = groups.get(parentId);
    if (existing) {
      if (!existing.actions.includes(action)) existing.actions.push(action);
    } else {
      groups.set(parentId, { parentLabel, actions: [action] });
    }
  }
  return [...groups.values()];
}

function formatObserved(record: ThresholdRecord): string {
  if (record.observed !== null && record.observed !== undefined) {
    return String(record.observed);
  }
  switch (record.status) {
    case "not-directly-tested":
      return "not directly tested";
    case "partially-tested":
      return "partially tested";
    case "met":
      return "met";
    case "not-met":
      return "not met";
  }
}

function statusClass(status: ThresholdStatus): string {
  switch (status) {
    case "met":
      return "text-emerald-300";
    case "not-met":
      return "text-rose-300";
    case "partially-tested":
      return "text-amber-300";
    case "not-directly-tested":
      return "text-neutral-400 italic";
  }
}

function groupByParent(nodes: TreeNode[]): Map<string, TreeNode[]> {
  const map = new Map<string, TreeNode[]>();
  for (const n of nodes) {
    if (!n.parent_id) continue;
    const arr = map.get(n.parent_id) ?? [];
    arr.push(n);
    map.set(n.parent_id, arr);
  }
  return map;
}

function countEvidenceUnder(
  hypothesis: HypothesisNode,
  subByParent: Map<string, TreeNode[]>,
  evByParent: Map<string, TreeNode[]>,
): number {
  const subs = subByParent.get(hypothesis.id) ?? [];
  let total = evByParent.get(hypothesis.id)?.length ?? 0;
  for (const s of subs) total += evByParent.get(s.id)?.length ?? 0;
  return total;
}

function byLabel(a: TreeNode, b: TreeNode): number {
  return a.label.localeCompare(b.label, undefined, { numeric: true });
}
