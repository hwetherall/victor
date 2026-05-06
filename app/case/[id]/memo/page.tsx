"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteMickyRun,
  fetchLatestRun,
  fetchMickyRuns,
  triggerMickyRun,
} from "@/lib/api-client";
import { MickyMemo } from "@/components/MickyMemo";
import type { MickyRun } from "@/lib/schema";

export default function MickyMemoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const queryClient = useQueryClient();
  const [selectedAttemptId, setSelectedAttemptId] = useState<string | null>(null);

  const latest = useQuery({
    queryKey: ["latest-run", id],
    queryFn: () => fetchLatestRun(id),
  });

  const runId = latest.data?.id ?? null;
  const mickyRuns = useQuery({
    queryKey: ["micky-runs", runId],
    queryFn: () => fetchMickyRuns(runId as string),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const runs = query.state.data ?? [];
      return runs.some((run) => run.status === "running") ? 1500 : false;
    },
  });

  const trigger = useMutation({
    mutationFn: () => triggerMickyRun(runId as string),
    onSuccess: () => {
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ["micky-runs", runId] });
      }, 500);
    },
  });

  const deleteAttempt = useMutation({
    mutationFn: (attemptId: string) => deleteMickyRun(runId as string, attemptId),
    onSuccess: () => {
      setSelectedAttemptId(null);
      queryClient.invalidateQueries({ queryKey: ["micky-runs", runId] });
    },
  });

  const completeRuns = useMemo(
    () => (mickyRuns.data ?? []).filter((run) => run.status === "complete"),
    [mickyRuns.data],
  );
  const displayedRun =
    completeRuns.find((run) => run.id === selectedAttemptId) ??
    completeRuns[0] ??
    null;
  const running = (mickyRuns.data ?? []).some((run) => run.status === "running");
  const failedRun = (mickyRuns.data ?? []).find((run) => run.status === "failed");

  useEffect(() => {
    if (!selectedAttemptId && completeRuns[0]) {
      setSelectedAttemptId(completeRuns[0].id);
    }
  }, [completeRuns, selectedAttemptId]);

  return (
    <main className="min-h-screen bg-[#f4f1ea] font-sans text-stone-900 print:bg-white">
      <div className="mx-auto max-w-6xl px-5 py-6 sm:px-8 lg:py-10 print:max-w-none print:px-0 print:py-0">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 print:hidden">
          <Link
            href={`/case/${id}`}
            className="rounded-md px-2 py-1 text-sm font-medium text-stone-500 hover:bg-white hover:text-stone-900"
          >
            ← case
          </Link>
          {runId && (
            <button
              type="button"
              onClick={() => trigger.mutate()}
              disabled={trigger.isPending || running}
              className="rounded-md border border-stone-300 bg-white px-3 py-2 text-sm font-semibold text-stone-800 shadow-sm hover:border-stone-400 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {trigger.isPending || running ? "Running..." : displayedRun ? "Regenerate" : "Ask Micky"}
            </button>
          )}
        </div>

        <div className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)] print:block">
          <aside className="order-2 lg:order-1 print:hidden">
            <div className="sticky top-6 space-y-5 text-sm text-stone-600">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                  Memo
                </p>
                <p className="mt-2 font-medium text-stone-900">
                  ABB rack PDU
                </p>
                {displayedRun && (
                  <p className="mt-1 text-xs text-stone-500">
                    Attempt {displayedRun.attempt_number}
                  </p>
                )}
              </div>

              {completeRuns.length > 1 && (
                <div className="space-y-2">
                  <label
                    htmlFor="micky-attempt"
                    className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400"
                  >
                    Version
                  </label>
                  <select
                    id="micky-attempt"
                    value={displayedRun?.id ?? ""}
                    onChange={(event) => setSelectedAttemptId(event.target.value)}
                    className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm text-stone-700"
                  >
                    {completeRuns.map((run) => (
                      <option key={run.id} value={run.id}>
                        Attempt {run.attempt_number}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {displayedRun && (
                <DeleteAttemptButton
                  run={displayedRun}
                  isDeleting={deleteAttempt.isPending}
                  onDelete={() => deleteAttempt.mutate(displayedRun.id)}
                />
              )}
            </div>
          </aside>

          <div className="order-1 min-w-0 lg:order-2">
            {(latest.isLoading || mickyRuns.isLoading) && (
              <p className="text-sm text-stone-500">Loading Micky&apos;s memo...</p>
            )}

            {latest.isError && (
              <p className="text-sm text-rose-700">
                Failed to load run: {(latest.error as Error).message}
              </p>
            )}
            {mickyRuns.isError && (
              <p className="text-sm text-rose-700">
                Failed to load memo: {(mickyRuns.error as Error).message}
              </p>
            )}

            {!latest.isLoading && !runId && (
              <section className="border border-stone-200 bg-white p-8 text-center shadow-sm">
                <h1 className="text-lg font-medium text-stone-800">
                  No completed run yet.
                </h1>
                <p className="mt-2 text-sm text-stone-500">
                  Run the case analysis first, then ask Micky for the partner memo.
                </p>
              </section>
            )}

            {runId &&
              !mickyRuns.isLoading &&
              (mickyRuns.data ?? []).length === 0 && (
                <section className="border border-stone-200 bg-white p-8 text-center shadow-sm">
                  <h1 className="text-lg font-medium text-stone-800">
                    No memo yet.
                  </h1>
                  <button
                    type="button"
                    onClick={() => trigger.mutate()}
                    disabled={trigger.isPending}
                    className="mt-5 rounded-md border border-stone-800 bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {trigger.isPending ? "Running..." : "Ask Micky"}
                  </button>
                </section>
              )}

            {failedRun && !running && !displayedRun && (
              <p className="mb-4 text-sm text-rose-700">
                Latest failed attempt: {failedRun.error ?? "Unknown error"}
              </p>
            )}

            {displayedRun?.output && (
              <div className="border border-stone-200 bg-white px-6 py-8 shadow-sm sm:px-10 lg:px-14 lg:py-12 print:border-0 print:p-0 print:shadow-none">
                <MickyMemo output={displayedRun.output} />
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function DeleteAttemptButton({
  run,
  isDeleting,
  onDelete,
}: {
  run: MickyRun;
  isDeleting: boolean;
  onDelete: () => void;
}) {
  return (
    <button
      type="button"
      disabled={isDeleting}
      onClick={() => {
        if (window.confirm(`Delete Micky attempt ${run.attempt_number}?`)) {
          onDelete();
        }
      }}
      className="text-xs text-stone-500 underline-offset-4 hover:text-rose-700 hover:underline disabled:cursor-not-allowed disabled:opacity-60"
    >
      delete this attempt
    </button>
  );
}
