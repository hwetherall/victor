"use client";

// Horizontal bar with green/amber/red bands per SPEC §3 + STORY-029 AC.

interface ConfidenceMeterProps {
  value: number | null;
  size?: "sm" | "md";
}

export function ConfidenceMeter({ value, size = "md" }: ConfidenceMeterProps) {
  const v = value ?? 0;
  const pct = Math.round(v * 100);
  const tone = colorFor(v);
  const height = size === "sm" ? "h-1.5" : "h-2";

  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline justify-between">
        <span className={`font-mono ${size === "sm" ? "text-xs" : "text-sm"} ${tone.text}`}>
          {value === null ? "—" : `${pct}%`}
        </span>
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          confidence
        </span>
      </div>
      <div className={`${height} w-full overflow-hidden rounded-full bg-neutral-800`}>
        <div
          className={`${height} ${tone.bar} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function colorFor(v: number): { text: string; bar: string } {
  if (v >= 0.7) return { text: "text-emerald-400", bar: "bg-emerald-500" };
  if (v >= 0.4) return { text: "text-amber-400", bar: "bg-amber-500" };
  return { text: "text-rose-400", bar: "bg-rose-500" };
}
