"use client";

// Orchestrates the entire run UX:
//   1. Looks for an existing complete run → "View Results" enters the kanban
//      directly (the demo-day path: pre-cached run, no live LLM calls).
//   2. Otherwise the "Run analysis" button POSTs to /api/runs and we start
//      polling /api/runs/[id] every 3s.
//   3. While running, surface a progress indicator over the placeholder canvas.
//   4. Once status='complete', flip to the Kanban view; clicks drill down
//      into hypothesis → sub-hypothesis → evidence → source modal.
//
// State model is a discriminated union (kanban | hypothesis | subhypothesis)
// so the breadcrumbs are mechanical and there's never an inconsistent shape.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchLatestRun,
  fetchRun,
  startRunRequest,
} from "@/lib/api-client";
import type { CaseConfig } from "@/lib/framework-registry";
import type { RunStatus } from "@/lib/schema";
import { TreeCanvas } from "./TreeCanvas";
import { KanbanBoard } from "./KanbanBoard";
import { HypothesisDrilldown } from "./HypothesisDrilldown";
import { EvidenceList } from "./EvidenceList";
import { EvidenceModal } from "./EvidenceModal";

interface CaseViewProps {
  caseConfigId: string;
  config: CaseConfig;
}

type View =
  | { kind: "kanban" }
  | { kind: "hypothesis"; hypothesisId: string }
  | {
      kind: "subhypothesis";
      subId: string;
      parentHypothesisId: string;
    };

const POLL_INTERVAL_MS = 3000;

export function CaseView({ caseConfigId, config }: CaseViewProps) {
  const queryClient = useQueryClient();

  const latest = useQuery({
    queryKey: ["latest-run", caseConfigId],
    queryFn: () => fetchLatestRun(caseConfigId),
  });

  // The run currently displayed (may be a cached one or one we just started).
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Adopt the latest cached run when it loads, unless the user has explicitly
  // started a new one.
  useEffect(() => {
    if (latest.data && !activeRunId) setActiveRunId(latest.data.id);
  }, [latest.data, activeRunId]);

  const runDetail = useQuery({
    queryKey: ["run", activeRunId],
    queryFn: () => fetchRun(activeRunId as string),
    enabled: activeRunId !== null,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return POLL_INTERVAL_MS;
      const isTerminal =
        data.run.status === "complete" || data.run.status === "failed";
      return isTerminal ? false : POLL_INTERVAL_MS;
    },
  });

  const startMutation = useMutation({
    mutationFn: () => startRunRequest(caseConfigId),
    onSuccess: ({ runId }) => {
      setActiveRunId(runId);
      queryClient.invalidateQueries({ queryKey: ["latest-run", caseConfigId] });
    },
  });

  // ─── View navigation ───────────────────────────────────────────────────────
  const [view, setView] = useState<View>({ kind: "kanban" });
  const [openEvidenceId, setOpenEvidenceId] = useState<string | null>(null);

  // Reset drill-down when switching runs.
  useEffect(() => {
    setView({ kind: "kanban" });
    setOpenEvidenceId(null);
  }, [activeRunId]);

  // ─── Render branches ──────────────────────────────────────────────────────
  const status: RunStatus | null = runDetail.data?.run.status ?? null;
  const showResults = status === "complete";

  return (
    <div className="flex flex-col gap-8">
      <Header
        config={config}
        status={status}
        hasCachedRun={Boolean(latest.data)}
        isStarting={startMutation.isPending}
        onStart={() => startMutation.mutate()}
        onView={() => {
          if (latest.data) setActiveRunId(latest.data.id);
        }}
        startError={
          startMutation.error instanceof Error
            ? startMutation.error.message
            : null
        }
        runError={runDetail.data?.run.error ?? null}
      />

      {!activeRunId && !latest.isLoading && (
        <TreeCanvas />
      )}

      {activeRunId && !showResults && (
        <RunProgress status={status} />
      )}

      {showResults && activeRunId && (
        <ResultsArea
          caseConfigId={caseConfigId}
          runId={activeRunId}
          view={view}
          setView={setView}
          openEvidenceId={openEvidenceId}
          setOpenEvidenceId={setOpenEvidenceId}
        />
      )}
    </div>
  );
}

// ─── Header / controls ───────────────────────────────────────────────────────

interface HeaderProps {
  config: CaseConfig;
  status: RunStatus | null;
  hasCachedRun: boolean;
  isStarting: boolean;
  onStart: () => void;
  onView: () => void;
  startError: string | null;
  runError: string | null;
}

function Header({
  config,
  status,
  hasCachedRun,
  isStarting,
  onStart,
  onView,
  startError,
  runError,
}: HeaderProps) {
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-neutral-800 bg-neutral-950 p-5">
      <div className="flex flex-wrap items-center gap-3">
        {hasCachedRun && status === "complete" ? (
          <button
            type="button"
            onClick={onView}
            className="rounded-md border border-emerald-600 bg-emerald-700/20 px-4 py-2 text-sm font-medium text-emerald-200 hover:bg-emerald-700/30"
          >
            View results
          </button>
        ) : (
          <button
            type="button"
            onClick={onStart}
            disabled={isStarting || status === "running" || status === "pending"}
            className="rounded-md border border-neutral-600 bg-neutral-900 px-4 py-2 text-sm font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isStarting
              ? "Starting…"
              : status === "running"
                ? "Run in progress…"
                : "Run analysis"}
          </button>
        )}
        {status && (
          <span className="text-xs font-mono text-neutral-500">
            status: {status}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            Framework
          </h2>
          <p className="text-sm text-neutral-300">{config.frameworkId}</p>
        </div>
        <div>
          <h2 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            Thresholds
          </h2>
          <ul className="space-y-0.5 text-xs">
            {Object.entries(config.thresholds).map(([k, v]) => (
              <li key={k} className="flex justify-between font-mono">
                <span className="text-neutral-500">{k}</span>
                <span className="text-neutral-300">{String(v)}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {startError && (
        <p className="text-xs text-rose-400">Start failed: {startError}</p>
      )}
      {runError && (
        <p className="text-xs text-rose-400">Run error: {runError}</p>
      )}
    </section>
  );
}

// ─── Progress ────────────────────────────────────────────────────────────────

function RunProgress({ status }: { status: RunStatus | null }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-8">
      <div className="flex items-center gap-3">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
        <p className="text-sm text-neutral-300">
          {status === "pending" && "Run pending…"}
          {status === "running" && "Gathering evidence and evaluating hypotheses…"}
          {status === "awaiting_input" && "Awaiting user input"}
          {status === "failed" && "Run failed."}
          {!status && "Connecting to run…"}
        </p>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        Live runs typically take 3–10 minutes (Tavily search + multi-model
        evaluation across all sub-hypotheses).
      </p>
    </div>
  );
}

// ─── Results (kanban + drill-down + evidence + modal) ───────────────────────

interface ResultsAreaProps {
  caseConfigId: string;
  runId: string;
  view: View;
  setView: (v: View) => void;
  openEvidenceId: string | null;
  setOpenEvidenceId: (id: string | null) => void;
}

function ResultsArea({
  caseConfigId,
  runId,
  view,
  setView,
  openEvidenceId,
  setOpenEvidenceId,
}: ResultsAreaProps) {
  return (
    <>
      {view.kind === "kanban" && (
        <KanbanBoard
          caseConfigId={caseConfigId}
          runId={runId}
          onSelectHypothesis={(hypothesisId) =>
            setView({ kind: "hypothesis", hypothesisId })
          }
        />
      )}
      {view.kind === "hypothesis" && (
        <HypothesisDrilldown
          runId={runId}
          hypothesisId={view.hypothesisId}
          onSelectSub={(subId) =>
            setView({
              kind: "subhypothesis",
              subId,
              parentHypothesisId: view.hypothesisId,
            })
          }
          onBack={() => setView({ kind: "kanban" })}
        />
      )}
      {view.kind === "subhypothesis" && (
        <EvidenceList
          runId={runId}
          subHypothesisId={view.subId}
          parentHypothesisId={view.parentHypothesisId}
          onSelectEvidence={(id) => setOpenEvidenceId(id)}
          onBack={() =>
            setView({
              kind: "hypothesis",
              hypothesisId: view.parentHypothesisId,
            })
          }
        />
      )}

      <EvidenceModal
        runId={runId}
        subHypothesisId={
          view.kind === "subhypothesis" ? view.subId : ""
        }
        evidenceNodeId={
          view.kind === "subhypothesis" ? openEvidenceId : null
        }
        onClose={() => setOpenEvidenceId(null)}
      />
    </>
  );
}
