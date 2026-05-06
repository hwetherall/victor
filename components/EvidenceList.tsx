"use client";

// Sub-hypothesis → list of evidence with For/Against/Mixed badges. Click an
// item to open the source modal (state lives in CaseView).

import { useQuery } from "@tanstack/react-query";
import { fetchNodeEvidence } from "@/lib/api-client";
import type {
  EvidenceContent,
  EvidenceSupports,
  EvidenceStrength,
  HypothesisContent,
  Source,
} from "@/lib/schema";
import { modelMeta } from "@/lib/model-labels";
import { ConfidenceMeter } from "./ConfidenceMeter";

interface EvidenceListProps {
  runId: string;
  subHypothesisId: string;
  parentHypothesisId: string;
  onSelectEvidence: (evidenceNodeId: string) => void;
  onBack: () => void;
}

export function EvidenceList({
  runId,
  subHypothesisId,
  parentHypothesisId,
  onSelectEvidence,
  onBack,
}: EvidenceListProps) {
  const q = useQuery({
    queryKey: ["evidence", runId, subHypothesisId],
    queryFn: () => fetchNodeEvidence(runId, subHypothesisId),
  });

  if (q.isLoading) {
    return <p className="text-sm text-neutral-400">Loading evidence…</p>;
  }
  if (q.isError) {
    return (
      <p className="text-sm text-rose-400">
        Failed to load: {(q.error as Error).message}
      </p>
    );
  }
  if (!q.data) return null;

  const parent = q.data.parentNode;
  const claim = (parent.content as HypothesisContent).claim ?? parent.label;
  const items = q.data.evidence;

  // Suppress the noisy "we ignored the parent prop" lint by using it.
  void parentHypothesisId;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-neutral-500 hover:text-neutral-200"
        >
          ← hypothesis
        </button>
        <span className="text-xs font-mono uppercase tracking-wider text-neutral-500">
          {parent.label}
        </span>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-5">
        <p className="text-base font-medium text-neutral-100">{claim}</p>
        <div className="mt-4 max-w-md">
          <ConfidenceMeter value={parent.confidence} />
        </div>
      </div>

      <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500">
        Evidence ({items.length})
      </h3>

      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No evidence rows for this sub-hypothesis.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => {
            const c = item.node.content as EvidenceContent;
            const sourceLabel = sourceLabelFor(item.source);
            return (
              <li key={item.node.id}>
                <button
                  type="button"
                  onClick={() => onSelectEvidence(item.node.id)}
                  className="flex w-full flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-left transition-colors hover:border-neutral-600"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <SupportsBadge supports={c.supports} />
                      <StrengthBadge strength={c.strength} />
                      {item.node.model_used && (
                        <ModelBadge modelUsed={item.node.model_used} />
                      )}
                    </div>
                    <span className="truncate text-[11px] text-neutral-500">
                      {sourceLabel}
                    </span>
                  </div>
                  <p className="text-sm text-neutral-200">{c.finding}</p>
                  {c.sourceQuote && (
                    <p className="border-l-2 border-neutral-800 pl-3 text-xs italic text-neutral-400">
                      “{c.sourceQuote}”
                    </p>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ─── Badges ──────────────────────────────────────────────────────────────────

function SupportsBadge({ supports }: { supports: EvidenceSupports }) {
  const cfg: Record<EvidenceSupports, { label: string; cls: string }> = {
    for: { label: "For", cls: "bg-emerald-500/15 text-emerald-300" },
    against: { label: "Against", cls: "bg-rose-500/15 text-rose-300" },
    mixed: { label: "Mixed", cls: "bg-neutral-500/15 text-neutral-300" },
  };
  const c = cfg[supports];
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

function StrengthBadge({ strength }: { strength: EvidenceStrength }) {
  const cls =
    strength === "strong"
      ? "border-neutral-300 text-neutral-200"
      : strength === "moderate"
        ? "border-neutral-500 text-neutral-400"
        : "border-neutral-700 text-neutral-500";
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${cls}`}
    >
      {strength}
    </span>
  );
}

function sourceLabelFor(source: Source | null): string {
  if (!source) return "—";
  if (source.type === "pdf") {
    const title = source.title ?? source.uri ?? "PDF";
    const page = source.metadata?.pageNumber;
    return page ? `${title} · p. ${page}` : title;
  }
  if (source.type === "web") {
    try {
      return source.uri ? new URL(source.uri).hostname : (source.title ?? "web");
    } catch {
      return source.title ?? "web";
    }
  }
  return source.title ?? source.type;
}

function ModelBadge({ modelUsed }: { modelUsed: string }) {
  const meta = modelMeta(modelUsed);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs uppercase tracking-wider ${meta.bgClass} ${meta.textClass}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {meta.label}
      {meta.badge && (
        <span className="ml-0.5 text-[10px] font-medium normal-case opacity-90">
          · {meta.badge}
        </span>
      )}
    </span>
  );
}
