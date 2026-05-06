import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";

// ─── Framework YAML shape (mirrors frameworks/*.yaml, SPEC §7.1) ─────────────

export interface FrameworkSlot {
  id: string;
  templateClaim: string;
  weight: number;
  decomposition?: string[];
}

export interface FrameworkTier1 {
  id: "tier-1";
  name: string;
  type: "AND-gate";
  slots: FrameworkSlot[];
}

export interface FrameworkTier2 {
  id: "tier-2";
  name: string;
  type: "COMPARATIVE";
  activatesIf: string;
  options: string[];
  criteria: string[];
}

export interface Framework {
  id: string;
  name: string;
  applicableTo: string[];
  tiers: [FrameworkTier1, FrameworkTier2];
}

// ─── Case YAML shape (mirrors cases/*.yaml, SPEC §7.2) ───────────────────────

export interface CaseInputDoc {
  path: string;
  type: "brief" | "pitch" | string;
  author?: string;
  stake?: string;
}

export interface CaseConfig {
  caseId: string;
  title: string;
  question: string;
  frameworkId: string;
  substitutions: Record<string, string>;
  weights: Record<string, number>;
  thresholds: Record<string, number>;
  inputDocs: CaseInputDoc[];
}

// ─── Loaders ─────────────────────────────────────────────────────────────────

const repoRoot = process.cwd();

export function loadFramework(id: string): Framework {
  const path = join(repoRoot, "frameworks", `${id}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Framework not found at ${path}: ${reason}`);
  }
  const parsed = parseYaml(raw) as Framework;
  if (!parsed?.id || parsed.id !== id) {
    throw new Error(
      `Framework file ${path} did not parse to a Framework with id="${id}"`,
    );
  }
  return parsed;
}

export function loadCase(caseId: string): CaseConfig {
  const path = join(repoRoot, "cases", `${caseId}.yaml`);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`Case config not found at ${path}: ${reason}`);
  }
  const parsed = parseYaml(raw) as CaseConfig;
  if (!parsed?.caseId || parsed.caseId !== caseId) {
    throw new Error(
      `Case file ${path} did not parse to a CaseConfig with caseId="${caseId}"`,
    );
  }
  return parsed;
}

export function applySubstitutions(
  template: string,
  subs: Record<string, string>,
): string {
  return template.replace(/\[([A-Z_]+)\]/g, (match, key: string) => {
    return subs[key] ?? match;
  });
}
