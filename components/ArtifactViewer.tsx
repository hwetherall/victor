"use client";

// STORY-024: render an Investigator-produced artifact inline.
//
// Supported types: xlsx (SheetJS, multi-tab), csv (table), png (img), md
// (sanitised), json + model_lineage (formatted). Version selector lands here
// (selector + dropdown only); the structured diff panel is STORY-026.
//
// Wedge-demo MVP scope (per spec-v2-plan.md): active xlsx tab renders as
// HTML table, all four tabs are navigable. Cell formatting, frozen panes,
// formula display deferred.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import * as XLSX from "xlsx";
import type { Artifact } from "@/lib/schema";

interface ArtifactViewerProps {
  /** Artifact rows for the current leaf, sorted by version asc. */
  artifacts: Artifact[];
  /** Optional override for the bytes URL. Defaults to `/api/dev/artifact/[id]/blob`. */
  resolveUrl?: (artifact: Artifact) => string;
}

export function ArtifactViewer({ artifacts, resolveUrl }: ArtifactViewerProps) {
  const sorted = useMemo(
    () => [...artifacts].sort((a, b) => a.version - b.version),
    [artifacts],
  );
  const [selectedId, setSelectedId] = useState<string>(
    () => sorted[sorted.length - 1]?.id ?? "",
  );
  const selected = sorted.find((a) => a.id === selectedId) ?? sorted[sorted.length - 1];

  if (sorted.length === 0) {
    return (
      <p className="text-sm text-neutral-500">
        No artifact for this leaf yet.
      </p>
    );
  }
  if (!selected) return null;

  return (
    <div className="flex flex-col gap-3">
      {sorted.length > 1 && (
        <div className="flex items-center gap-3">
          <label className="text-[10px] uppercase tracking-wider text-neutral-500">
            Version
          </label>
          <select
            value={selected.id}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-200"
          >
            {sorted.map((a) => (
              <option key={a.id} value={a.id}>
                v{a.version}
                {a.parent_artifact_id ? "" : " (initial)"}
              </option>
            ))}
          </select>
          <span className="text-[11px] text-neutral-500">
            {sorted.length} version{sorted.length > 1 ? "s" : ""}
          </span>
        </div>
      )}

      <ArtifactBody artifact={selected} resolveUrl={resolveUrl} />

      <details className="text-[11px] text-neutral-500">
        <summary className="cursor-pointer">metadata</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-900/40 p-2 font-mono text-[10px]">
          {JSON.stringify(selected.metadata ?? {}, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// ─── Body — dispatches by artifact.type ──────────────────────────────────────

function ArtifactBody({
  artifact,
  resolveUrl,
}: {
  artifact: Artifact;
  resolveUrl?: (a: Artifact) => string;
}) {
  const url = resolveUrl ? resolveUrl(artifact) : `/api/dev/artifact/${artifact.id}/blob`;

  switch (artifact.type) {
    case "xlsx":
      return <XlsxView url={url} artifactId={artifact.id} />;
    case "csv":
      return <CsvView url={url} artifactId={artifact.id} />;
    case "png":
      return <PngView url={url} filename={defaultFilename(artifact)} />;
    case "md":
      return <MdView url={url} artifactId={artifact.id} />;
    case "json":
    case "model_lineage":
      return <JsonView url={url} artifactId={artifact.id} />;
    default:
      return (
        <p className="text-sm text-rose-400">
          Unknown artifact type: {String((artifact as { type: string }).type)}
        </p>
      );
  }
}

function defaultFilename(a: Artifact): string {
  const tail = a.uri.split("/").pop() ?? `artifact.${a.type}`;
  return tail;
}

// ─── XLSX ────────────────────────────────────────────────────────────────────

interface ParsedXlsx {
  sheetNames: string[];
  /** Per sheet: an array of rows, each a string[]. SheetJS typings are loose;
   *  we coerce values to strings at the renderer boundary. */
  sheets: Record<string, string[][]>;
}

function XlsxView({ url, artifactId }: { url: string; artifactId: string }) {
  const q = useQuery({
    queryKey: ["artifact-xlsx", artifactId, url],
    queryFn: async (): Promise<ParsedXlsx> => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching artifact`);
      const buf = await res.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const sheets: Record<string, string[][]> = {};
      for (const name of wb.SheetNames) {
        const ws = wb.Sheets[name];
        const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
          header: 1,
          defval: "",
          raw: false,
        });
        sheets[name] = rows.map((r) =>
          r.map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
        );
      }
      return { sheetNames: wb.SheetNames, sheets };
    },
  });
  const [activeTab, setActiveTab] = useState<string | null>(null);

  if (q.isLoading) return <ViewerSkeleton label="Loading xlsx…" />;
  if (q.isError) return <ViewerError error={q.error as Error} />;
  if (!q.data) return null;

  const tab = activeTab && q.data.sheetNames.includes(activeTab)
    ? activeTab
    : q.data.sheetNames[0];
  const rows = q.data.sheets[tab] ?? [];

  return (
    <div className="rounded border border-neutral-800 bg-neutral-950">
      <div className="flex flex-wrap gap-1 border-b border-neutral-800 px-2 py-1.5">
        {q.data.sheetNames.map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setActiveTab(name)}
            className={`rounded px-2.5 py-1 text-xs ${
              name === tab
                ? "bg-emerald-700/40 text-emerald-100"
                : "text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            }`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="max-h-[60vh] overflow-auto">
        <table className="w-full border-collapse text-xs">
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className={ri === 0 ? "bg-neutral-900/60 font-medium" : ""}>
                {row.map((cell, ci) => (
                  <td
                    key={ci}
                    className={`border-r border-b border-neutral-900 px-2 py-1 align-top text-neutral-200 ${
                      ri === 0 ? "text-neutral-100" : ""
                    }`}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td className="px-3 py-4 text-sm text-neutral-500">(empty sheet)</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

function CsvView({ url, artifactId }: { url: string; artifactId: string }) {
  const q = useQuery({
    queryKey: ["artifact-csv", artifactId, url],
    queryFn: async (): Promise<string[][]> => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // SheetJS parses CSV uniformly; cheap and consistent with xlsx path.
      const wb = XLSX.read(text, { type: "string" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        defval: "",
        raw: false,
      });
      return rows.map((r) =>
        r.map((cell) => (cell === null || cell === undefined ? "" : String(cell))),
      );
    },
  });

  if (q.isLoading) return <ViewerSkeleton label="Loading csv…" />;
  if (q.isError) return <ViewerError error={q.error as Error} />;
  if (!q.data) return null;

  const rows = q.data.slice(0, 200); // spec: cap at 200 rows
  return (
    <div className="max-h-[60vh] overflow-auto rounded border border-neutral-800 bg-neutral-950">
      <table className="w-full border-collapse text-xs">
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} className={ri === 0 ? "bg-neutral-900/60 font-medium" : ""}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  className="border-r border-b border-neutral-900 px-2 py-1 align-top text-neutral-200"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {q.data.length > 200 && (
        <p className="px-3 py-2 text-[11px] text-neutral-500">
          (showing first 200 of {q.data.length} rows)
        </p>
      )}
    </div>
  );
}

// ─── PNG ─────────────────────────────────────────────────────────────────────

function PngView({ url, filename }: { url: string; filename: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-3">
      <img
        src={url}
        alt={filename}
        className="max-h-[60vh] max-w-full rounded border border-neutral-800 object-contain"
      />
      <a
        href={url}
        download={filename}
        className="mt-2 inline-block text-xs text-emerald-400 hover:underline"
      >
        Download {filename}
      </a>
    </div>
  );
}

// ─── Markdown ────────────────────────────────────────────────────────────────

function MdView({ url, artifactId }: { url: string; artifactId: string }) {
  const q = useQuery({
    queryKey: ["artifact-md", artifactId, url],
    queryFn: async () => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
  });
  if (q.isLoading) return <ViewerSkeleton label="Loading…" />;
  if (q.isError) return <ViewerError error={q.error as Error} />;
  if (!q.data) return null;
  // Plain-text rendering for now — react-markdown isn't in the bundle and the
  // demo only needs readable prose. Pre-wrapped preserves headings + bullets
  // without HTML parsing risk.
  return (
    <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950 p-3 text-xs leading-relaxed text-neutral-200">
      {q.data}
    </pre>
  );
}

// ─── JSON / model_lineage ────────────────────────────────────────────────────

function JsonView({ url, artifactId }: { url: string; artifactId: string }) {
  const q = useQuery({
    queryKey: ["artifact-json", artifactId, url],
    queryFn: async () => {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        return { parsed: JSON.parse(text) as unknown, raw: text };
      } catch {
        return { parsed: null, raw: text };
      }
    },
  });
  if (q.isLoading) return <ViewerSkeleton label="Loading…" />;
  if (q.isError) return <ViewerError error={q.error as Error} />;
  if (!q.data) return null;
  const display = q.data.parsed === null ? q.data.raw : JSON.stringify(q.data.parsed, null, 2);
  return (
    <pre className="max-h-[60vh] overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 font-mono text-[11px] text-neutral-200">
      {display}
    </pre>
  );
}

// ─── Common UI bits ──────────────────────────────────────────────────────────

function ViewerSkeleton({ label }: { label: string }) {
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 p-4 text-xs text-neutral-500">
      {label}
    </div>
  );
}

function ViewerError({ error }: { error: Error }) {
  return (
    <div className="rounded border border-rose-700/60 bg-rose-950/30 p-3 text-xs text-rose-300">
      Failed: {error.message}
    </div>
  );
}
