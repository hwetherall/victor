// Display metadata for model_used strings produced by the pipeline. Shared by
// the evidence list (per-row badge) and the decision card (models-used
// footer). Tailwind class names are pre-baked so consumers don't have to map.

export interface ModelMeta {
  /** Short human label, lowercase ("opus", "sonnet", "mistral", ...). */
  label: string;
  /** Optional decoration label for specialised roles ("red team"). */
  badge?: string;
  /** Tailwind text color class for the dot/pill. */
  textClass: string;
  /** Tailwind background tint class for the pill. */
  bgClass: string;
  /** Sort priority (lower = leftmost in the footer). */
  order: number;
}

const FALLBACK: ModelMeta = {
  label: "model",
  textClass: "text-neutral-300",
  bgClass: "bg-neutral-800",
  order: 99,
};

export function modelMeta(modelUsed: string | null | undefined): ModelMeta {
  if (!modelUsed) return FALLBACK;
  const m = modelUsed.toLowerCase();

  if (m.includes("contrarian")) {
    return {
      label: "sonnet",
      badge: "red team",
      textClass: "text-amber-300",
      bgClass: "bg-amber-500/15",
      order: 5,
    };
  }
  if (m.includes("vision")) {
    return {
      label: "sonnet",
      badge: "vision",
      textClass: "text-fuchsia-300",
      bgClass: "bg-fuchsia-500/15",
      order: 1,
    };
  }
  if (m.includes("opus")) {
    return {
      label: "opus",
      textClass: "text-emerald-300",
      bgClass: "bg-emerald-500/15",
      order: 0,
    };
  }
  if (m.includes("sonnet")) {
    return {
      label: "sonnet",
      textClass: "text-sky-300",
      bgClass: "bg-sky-500/15",
      order: 2,
    };
  }
  if (m.includes("mistral")) {
    return {
      label: "mistral",
      textClass: "text-violet-300",
      bgClass: "bg-violet-500/15",
      order: 3,
    };
  }
  if (m.includes("gemini")) {
    return {
      label: "gemini",
      textClass: "text-amber-200",
      bgClass: "bg-amber-400/10",
      order: 4,
    };
  }
  if (m.includes("gpt")) {
    return {
      label: "gpt",
      textClass: "text-teal-300",
      bgClass: "bg-teal-500/15",
      order: 6,
    };
  }
  return { ...FALLBACK, label: modelUsed.slice(0, 12) };
}

/** Short text-only label, kept for places that don't render a coloured pill. */
export function modelTag(modelUsed: string | null | undefined): string {
  return modelMeta(modelUsed).label;
}

/**
 * Distinct model pills for a footer/header. Aggregates by (label, badge)
 * pairs so a "sonnet" evaluator and "sonnet (red team)" contrarian render as
 * separate pills, while two evaluator-Sonnet runs collapse into one.
 */
export function aggregateModels(
  modelUsedValues: Iterable<string | null | undefined>,
): ModelMeta[] {
  const seen = new Map<string, ModelMeta>();
  for (const v of modelUsedValues) {
    if (!v) continue;
    const meta = modelMeta(v);
    const key = `${meta.label}::${meta.badge ?? ""}`;
    if (!seen.has(key)) seen.set(key, meta);
  }
  return Array.from(seen.values()).sort((a, b) => a.order - b.order);
}
