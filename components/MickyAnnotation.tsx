import type { MickyOutput } from "@/lib/schema";

interface MickyAnnotationProps {
  rankEntry: MickyOutput["hypothesisRanking"][number] | null;
  decompEntry: MickyOutput["hypothesisDecomposition"][number] | null;
}

export function MickyAnnotation({
  rankEntry,
  decompEntry,
}: MickyAnnotationProps) {
  if (!rankEntry && !decompEntry) return null;

  return (
    <aside className="flex gap-2 border-l-2 border-stone-300 pl-3 text-sm italic text-neutral-400">
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-700 text-[9px] not-italic text-white">
        MB
      </span>
      <span>
        {rankEntry && <>AI · Micky&apos;s note: {rankingRationale(rankEntry)}</>}
        {decompEntry && decompEntry.whatWasCut.length > 0 && (
          <>
            {rankEntry ? " " : "AI · Micky's note: "}
            {formatCuts(decompEntry.whatWasCut)} {decompRationale(decompEntry)}
          </>
        )}
      </span>
    </aside>
  );
}

function rankingRationale(
  entry: MickyOutput["hypothesisRanking"][number],
): string {
  return entry.rationale ?? (entry as unknown as { whyThisRank?: string }).whyThisRank ?? "";
}

function decompRationale(
  entry: MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.rationale ?? (entry as unknown as { whyThese?: string }).whyThese ?? "";
}

function formatCuts(
  items: MickyOutput["hypothesisDecomposition"][number]["whatWasCut"],
): string {
  const normalized = (items as Array<string | { type?: string; name: string }>).map(
    (item) => (typeof item === "string" ? { type: "hypothesis", name: item } : item),
  );
  const hypotheses = normalized
    .filter((item) => item.type === "hypothesis")
    .map((item) => item.name);
  const methods = normalized
    .filter((item) => item.type === "method")
    .map((item) => item.name);
  const scope = normalized
    .filter((item) => item.type === "scope")
    .map((item) => item.name);
  const parts = [
    hypotheses.length ? `Cut hypotheses: ${hypotheses.join(", ")}.` : null,
    methods.length ? `Methods not used: ${methods.join(", ")}.` : null,
    scope.length ? `Scope choices: ${scope.join(", ")}.` : null,
  ].filter(Boolean);
  return parts.join(" ");
}
