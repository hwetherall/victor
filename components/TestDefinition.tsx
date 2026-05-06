// Compact <details> block exposing the test framing behind a hypothesis:
// falsifier, test metric/target/horizon, insight at stake, mode dependence.
// Pure presentational — feed it the hypothesis content directly.

import type { HypothesisContent, HypothesisTest } from "@/lib/schema";

interface TestDefinitionProps {
  content: HypothesisContent;
  defaultOpen?: boolean;
}

export function TestDefinition({
  content,
  defaultOpen = false,
}: TestDefinitionProps) {
  const rows: Array<{ label: string; value: string }> = [];

  if (content.falsifier) {
    rows.push({ label: "Falsifier", value: content.falsifier });
  }
  if (content.test) {
    rows.push({ label: "Test", value: formatTest(content.test) });
  }
  if (content.insightAtStake) {
    rows.push({
      label: "Insight at stake",
      value: content.insightAtStake.startsWith("If ")
        ? content.insightAtStake
        : `If false, ${content.insightAtStake}`,
    });
  }
  if (content.modeDependence) {
    rows.push({ label: "Mode dependence", value: content.modeDependence });
  }

  if (rows.length === 0) return null;

  return (
    <details
      open={defaultOpen}
      className="group rounded-lg border border-neutral-800 bg-neutral-950/60 p-4 text-sm"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between text-[10px] font-medium uppercase tracking-widest text-neutral-500 hover:text-neutral-300">
        <span>How we tested this</span>
        <span className="text-neutral-600 transition-transform group-open:rotate-90">
          ›
        </span>
      </summary>
      <dl className="mt-3 space-y-2.5">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
              {r.label}
            </dt>
            <dd className="mt-0.5 text-xs leading-relaxed text-neutral-300">
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function formatTest(t: HypothesisTest): string {
  const horizon = t.horizon ? ` over ${t.horizon}` : "";
  return `${t.type} on ${t.metric} · target ${t.target}${horizon}`;
}
