"use client";

// Final stop in the drill-down: the source modal. Renders web (URL + quote) or
// PDF (title + page + quote) flavours via SourceViewer. Data is loaded once
// from the same evidence query the list view used (TanStack Query cache hit),
// so opening is effectively instant — satisfies STORY-032 AC: pre-cached at
// run time, not fetched on click.

import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchNodeEvidence } from "@/lib/api-client";
import type { EvidenceContent, Source } from "@/lib/schema";
import type { EvidenceItem } from "@/app/api/runs/[id]/nodes/[nodeId]/evidence/route";

interface EvidenceModalProps {
  runId: string;
  subHypothesisId: string;
  evidenceNodeId: string | null;
  onClose: () => void;
}

export function EvidenceModal({
  runId,
  subHypothesisId,
  evidenceNodeId,
  onClose,
}: EvidenceModalProps) {
  // Reuse the cached evidence list query rather than a per-node fetch.
  const q = useQuery({
    queryKey: ["evidence", runId, subHypothesisId],
    queryFn: () => fetchNodeEvidence(runId, subHypothesisId),
    enabled: evidenceNodeId !== null,
  });

  useEffect(() => {
    if (!evidenceNodeId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [evidenceNodeId, onClose]);

  if (!evidenceNodeId) return null;

  const item = q.data?.evidence.find((e) => e.node.id === evidenceNodeId);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-medium text-neutral-200">Source</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-neutral-500 hover:text-neutral-200"
            aria-label="Close"
          >
            close · esc
          </button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          {q.isLoading && (
            <p className="text-sm text-neutral-500">Loading source…</p>
          )}
          {q.isError && (
            <p className="text-sm text-rose-400">
              Failed to load: {(q.error as Error).message}
            </p>
          )}
          {q.data && !item && (
            <p className="text-sm text-neutral-500">
              Evidence node not found in this sub-hypothesis.
            </p>
          )}
          {item && <SourceViewer item={item} />}
        </div>
      </div>
    </div>
  );
}

// ─── Inner viewer ────────────────────────────────────────────────────────────

function SourceViewer({ item }: { item: EvidenceItem }) {
  const evidence = item.node.content as EvidenceContent;
  const source = item.source;
  const link = item.link;
  const quote = link?.quote ?? evidence.sourceQuote ?? null;

  return (
    <div className="flex flex-col gap-5">
      <section>
        <h3 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          Finding
        </h3>
        <p className="text-sm text-neutral-100">{evidence.finding}</p>
      </section>

      <section>
        <h3 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
          Source
        </h3>
        {source ? (
          source.type === "pdf" ? (
            <PdfSource source={source} pageNumber={link?.page_number ?? null} />
          ) : (
            <WebSource source={source} />
          )
        ) : (
          <p className="text-sm text-neutral-500">
            No source row linked to this evidence node.
          </p>
        )}
      </section>

      {quote && (
        <section>
          <h3 className="mb-2 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
            Quoted passage
          </h3>
          <blockquote className="border-l-2 border-emerald-700/50 bg-neutral-900/40 p-3 text-sm italic text-neutral-200">
            “{quote}”
          </blockquote>
        </section>
      )}

      {source?.metadata?.stake && (
        <p className="text-[11px] text-neutral-500">
          Document stake:{" "}
          <span className="font-mono text-neutral-300">
            {String(source.metadata.stake)}
          </span>
        </p>
      )}
    </div>
  );
}

function WebSource({ source }: { source: Source }) {
  const host = (() => {
    try {
      return source.uri ? new URL(source.uri).hostname : "—";
    } catch {
      return source.uri ?? "—";
    }
  })();
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <p className="truncate text-sm font-medium text-neutral-100">
        {source.title ?? host}
      </p>
      {source.uri && (
        <a
          href={source.uri}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 block truncate text-xs text-emerald-400 hover:underline"
        >
          {source.uri}
        </a>
      )}
    </div>
  );
}

function PdfSource({
  source,
  pageNumber,
}: {
  source: Source;
  pageNumber: number | null;
}) {
  const page = pageNumber ?? source.metadata?.pageNumber ?? null;
  return (
    <div className="rounded border border-neutral-800 bg-neutral-900/40 p-3">
      <p className="text-sm font-medium text-neutral-100">
        {source.title ?? source.uri ?? "PDF document"}
      </p>
      <div className="mt-1 flex items-center gap-3 text-xs text-neutral-400">
        {page !== null && page !== undefined && <span>page {page}</span>}
        {source.metadata?.author !== undefined && (
          <span>author: {String(source.metadata.author)}</span>
        )}
      </div>
    </div>
  );
}
