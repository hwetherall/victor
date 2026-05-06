// Renders the AI's rationale conclusion in a confidence-tinted callout.
// Used as a "verdict" hero on sub-hypothesis pages. Pure presentational.

interface VerdictPanelProps {
  rationale: string;
  confidence: number | null;
}

export function VerdictPanel({ rationale, confidence }: VerdictPanelProps) {
  const tone = colorFor(confidence ?? 0);

  return (
    <section
      className={`rounded-lg border ${tone.border} ${tone.bg} border-l-4 p-5`}
    >
      <div className="mb-2 flex items-baseline justify-between">
        <span
          className={`text-[10px] font-medium uppercase tracking-widest ${tone.label}`}
        >
          Verdict
        </span>
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          why this confidence
        </span>
      </div>
      <p className="text-sm leading-relaxed text-neutral-200">{rationale}</p>
    </section>
  );
}

function colorFor(v: number): {
  border: string;
  bg: string;
  label: string;
} {
  if (v >= 0.7) {
    return {
      border: "border-emerald-700/40",
      bg: "bg-emerald-950/20",
      label: "text-emerald-400",
    };
  }
  if (v >= 0.4) {
    return {
      border: "border-amber-700/40",
      bg: "bg-amber-950/20",
      label: "text-amber-400",
    };
  }
  return {
    border: "border-rose-700/40",
    bg: "bg-rose-950/20",
    label: "text-rose-400",
  };
}
