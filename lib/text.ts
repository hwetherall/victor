// Text helpers shared across server agents and client renderers.

const ELLIPSIS = "…";

/**
 * Truncate at the last word boundary that fits within `max` characters
 * (including the trailing ellipsis). If `s` already fits, return it
 * unchanged. If no whitespace fits, fall back to a hard char cut so we
 * never exceed `max`.
 */
export function truncateAtWordBoundary(s: string, max: number): string {
  if (max <= 1) return s.length <= max ? s : ELLIPSIS;
  if (s.length <= max) return s;

  const budget = max - ELLIPSIS.length;
  const window = s.slice(0, budget + 1);
  const lastSpace = window.lastIndexOf(" ");

  if (lastSpace > 0) return s.slice(0, lastSpace).trimEnd() + ELLIPSIS;
  return s.slice(0, budget) + ELLIPSIS;
}
