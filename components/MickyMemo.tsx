import type { MickyOutput } from "@/lib/schema";
import type { ReactNode } from "react";

const NOT_ADVICE =
  "This AI-generated memo is decision support only and does not constitute professional consulting, legal, or financial advice. Apply independent judgment before acting.";

export function MickyMemo({ output }: { output: MickyOutput }) {
  return (
    <article className="mx-auto max-w-[760px] text-[15px] leading-7 text-stone-800">
      <header className="border-b border-stone-200 pb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="rounded-full border border-stone-300 bg-stone-50 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-600">
            AI-generated · Micky
          </span>
          <span className="text-xs text-stone-400">
            {output.signOff.monogram} · {output.signOff.date}
          </span>
        </div>
      </header>

      {output.reframe && (
        <section className="border-b border-stone-200 py-8 print:py-5">
          <SectionEyebrow>The reframe</SectionEyebrow>
          <h2 className="mt-3 max-w-3xl font-serif text-[clamp(1.85rem,3vw,2.65rem)] leading-[1.08] text-stone-950 print:text-[30px]">
            {output.reframe.headline}
          </h2>
          <p className="mt-5 max-w-2xl leading-7 text-stone-700 print:mt-4">
            {polishMemoText(output.reframe.reasoning)}
          </p>
        </section>
      )}

      <section className="border-b border-stone-200 py-7 print:py-5">
        <SectionEyebrow>Recommendation</SectionEyebrow>
        <p className="mt-3 text-lg font-semibold leading-7 text-stone-950">
          {polishMemoText(output.recommendation.oneLiner)}
        </p>
        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <MemoPoint
            label="Weakest link"
            text={output.recommendation.weakestLink}
          />
          <MemoPoint
            label="What would flip it"
            text={output.recommendation.whatWouldFlipIt}
          />
        </div>
      </section>

      <section className="border-b border-stone-200 py-7 print:py-5">
        <SectionEyebrow>Framework rationale</SectionEyebrow>
        <p className="mt-3 text-base font-medium text-stone-950">
          {output.frameworkRationale.chosen}
        </p>
        {output.frameworkRationale.rejected.length > 0 && (
          <div className="mt-4 space-y-3">
            {output.frameworkRationale.rejected.map((item) => (
              <div
                key={`${item.type}-${item.name}-${item.whyCut}`}
                className="border-l border-stone-300 pl-4"
              >
                <p className="text-sm font-medium text-stone-700">
                  {item.name}
                </p>
                <p className="mt-1 text-sm leading-6 text-stone-500">
                  {polishMemoText(item.whyCut)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>

      {output.hypothesisRanking.length > 0 && (
        <section className="border-b border-stone-200 py-7 print:py-5">
          <SectionEyebrow>Binding constraints</SectionEyebrow>
          <div className="mt-4 space-y-3" role="list">
            {[...output.hypothesisRanking]
              .sort((a, b) => a.rank - b.rank)
              .map((entry) => (
                <div
                  key={rankingId(entry)}
                  className="grid grid-cols-[2rem_1fr] gap-3"
                  role="listitem"
                >
                  <span className="pt-0.5 font-mono text-sm text-stone-400">
                    {entry.rank}
                  </span>
                  <p className="text-sm leading-6 text-stone-700">
                    <span className="font-semibold text-stone-950">
                      {rankingLabel(entry)}
                    </span>
                    <span className="text-stone-400"> · </span>
                    {polishMemoText(rankingRationale(entry))}
                  </p>
                </div>
              ))}
          </div>
        </section>
      )}

      {output.hypothesisDecomposition.length > 0 && (
        <section className="border-b border-stone-200 py-7 print:py-5">
          <SectionEyebrow>Hypothesis decomposition</SectionEyebrow>
          <div className="mt-5 space-y-6">
          {output.hypothesisDecomposition.map((entry) => (
            <div key={decompId(entry)}>
              <p className="text-base font-semibold text-stone-950">
                {decompLabel(entry)}
              </p>
              <p className="mt-2 text-sm leading-6 text-stone-700">
                {polishMemoText(decompRationale(entry))}
              </p>
              <CutBuckets items={entry.whatWasCut} />
            </div>
          ))}
          </div>
        </section>
      )}

      {output.judgmentCalls.length > 0 && (
        <section className="border-b border-stone-200 py-7 print:py-5">
          <SectionEyebrow>Judgment calls</SectionEyebrow>
          <div className="mt-4 space-y-5">
          {output.judgmentCalls.map((item) => (
            <div key={`${item.area}-${item.thinness}`}>
              <p className="text-sm font-semibold text-stone-950">
                {item.area}
              </p>
              <p className="mt-1 text-sm leading-6 text-stone-700">
                {polishMemoText(item.thinness)}
              </p>
              <p className="mt-1 border-l border-stone-300 pl-4 text-sm leading-6 text-stone-500">
                {polishMemoText(item.whyIWentThere)}
              </p>
            </div>
          ))}
          </div>
        </section>
      )}

      {output.pushback.length > 0 && (
        <section className="border-b border-stone-200 py-7 print:py-5">
          <SectionEyebrow>How I'd push back</SectionEyebrow>
          <ul className="mt-4 space-y-3">
            {output.pushback.map((item, i) => (
              <li
                key={i}
                className="border-l border-stone-300 pl-4 text-sm leading-6 text-stone-700"
              >
                {polishMemoText(item.challenge)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="space-y-4 py-6">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-stone-900 text-sm text-white">
            {output.signOff.monogram}
          </span>
          <span className="text-xs font-medium text-stone-500">
            {output.signOff.date}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-stone-400">{NOT_ADVICE}</p>
        <p className="text-xs leading-relaxed text-stone-400">
          This memo was generated by an AI system. It is not the work of a human
          partner.
        </p>
      </footer>
    </article>
  );
}

function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-stone-500">
      {children}
    </h3>
  );
}

function MemoPoint({ label, text }: { label: string; text: string }) {
  return (
    <div className="border-l border-stone-300 pl-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-500">
        {label}
      </p>
      <p className="mt-1 text-sm leading-6 text-stone-700">
        {polishMemoText(text)}
      </p>
    </div>
  );
}

function rankingId(entry: MickyOutput["hypothesisRanking"][number]): string {
  return entry.hypothesisId ?? (entry as unknown as { id?: string }).id ?? String(entry.rank);
}

function rankingLabel(entry: MickyOutput["hypothesisRanking"][number]): string {
  return entry.hypothesisLabel ?? "(unlabeled hypothesis)";
}

function rankingRationale(entry: MickyOutput["hypothesisRanking"][number]): string {
  return entry.rationale ?? (entry as unknown as { whyThisRank?: string }).whyThisRank ?? "";
}

function decompId(
  entry: MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.hypothesisId ?? (entry as unknown as { hypId?: string }).hypId ?? entry.hypothesisLabel;
}

function decompLabel(
  entry: MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.hypothesisLabel ?? "(unlabeled hypothesis)";
}

function decompRationale(
  entry: MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.rationale ?? (entry as unknown as { whyThese?: string }).whyThese ?? "";
}

function CutBuckets({
  items,
}: {
  items: MickyOutput["hypothesisDecomposition"][number]["whatWasCut"];
}) {
  const normalized = items.map((item) =>
    typeof item === "string"
      ? { type: "hypothesis", name: item, whyCut: "" }
      : item,
  );
  const buckets = [
    ["hypothesis", "Cut hypotheses"],
    ["method", "Methods not used"],
    ["scope", "Scope choices"],
  ] as const;

  return (
    <div className="mt-3 space-y-2">
      {buckets.map(([type, label]) => {
        const bucket = normalized.filter((item) => item.type === type);
        if (bucket.length === 0) return null;
        return (
          <div
            key={type}
            className="border-l border-stone-200 pl-4 text-sm leading-6 text-stone-500"
          >
            <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
              {label}
            </p>
            <ul className="mt-1 space-y-1">
              {bucket.map((item) => (
                <li key={`${item.type}-${item.name}`}>
                  <span className="font-medium text-stone-700">
                    {item.name}
                  </span>
                  {item.whyCut ? ` - ${polishMemoText(item.whyCut)}` : null}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function polishMemoText(value: string): string {
  return value
    .replace(/\bwhich scores ([a-z-]+) at 0\.\d+\s*:/gi, "which is $1:")
    .replace(/\b(scores?|scored)\s+([a-z-]+)\s+at\s+0\.\d+\b/gi, "is $2")
    .replace(/\s+at\s+0\.\d+\s*:/gi, ":")
    .replace(/\((?:confidence\s*)?0\.\d+\)/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
