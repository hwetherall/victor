// Test-driven query builder. improve.md §3.
//
// The previous v1+v2 path read only the hypothesis claim/label, which produced
// topic-aligned but test-misaligned queries (e.g. SH4.2's NPV question
// returned six market-growth links). The fix: drive query generation from
// `test.metric` via a per-framework yaml of templates that explicitly bias
// toward the test variable.
//
// File location: `frameworks/<frameworkId>.query-templates.yaml`. Per-case
// override may be added at `cases/<caseId>.query-templates.yaml` later — Q3
// recommendation. Templates use the same [BRACKET_KEY] substitution syntax
// as the framework yaml.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { applySubstitutions } from "./framework-registry";
import type { HypothesisContent } from "./schema";

interface TemplateFile {
  templates: Record<string, string[]>;
  fallback?: string[];
}

const cache = new Map<string, TemplateFile | null>();

function loadFrameworkTemplates(frameworkId: string): TemplateFile | null {
  if (cache.has(frameworkId)) return cache.get(frameworkId) ?? null;
  const path = join(
    process.cwd(),
    "frameworks",
    `${frameworkId}.query-templates.yaml`,
  );
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    cache.set(frameworkId, null);
    return null;
  }
  const parsed = parseYaml(raw) as TemplateFile;
  if (!parsed?.templates || typeof parsed.templates !== "object") {
    cache.set(frameworkId, null);
    return null;
  }
  cache.set(frameworkId, parsed);
  return parsed;
}

export interface QueryBuilderContext {
  frameworkId: string;
  /** From cases/<id>.yaml — supplies [COMPANY], [PRODUCT], etc. */
  substitutions: Record<string, string>;
}

/**
 * Returns 0–N test-driven queries for a hypothesis. Returns an empty array
 * when the test.metric has no template AND the file has no fallback;
 * callers should fall through to the v2 claim-based path in that case.
 */
export function buildTestDrivenQueries(
  content: HypothesisContent,
  ctx: QueryBuilderContext,
): string[] {
  const file = loadFrameworkTemplates(ctx.frameworkId);
  if (!file) return [];

  const metric = content.test?.metric;
  const raw: string[] =
    (metric ? file.templates[metric] : undefined) ?? file.fallback ?? [];
  if (raw.length === 0) return [];

  const subs = enrichedSubs(content, ctx.substitutions);
  return raw.map((q) => applySubstitutions(q, subs).trim()).filter(Boolean);
}

function enrichedSubs(
  content: HypothesisContent,
  base: Record<string, string>,
): Record<string, string> {
  return {
    ...base,
    TARGET: String(content.test?.target ?? ""),
    METRIC: String(content.test?.metric ?? ""),
    HORIZON: content.test?.horizon ?? base.HORIZON ?? "",
    CLAIM: content.claim,
  };
}

// Test hooks — used by smoke scripts to clear the cache between runs.
export const __test = {
  clearCache: () => cache.clear(),
};
