// Export the latest run for a case as a local Markdown report.
//
// Run:
//   npx tsx --conditions=import scripts/export-run-markdown.ts
//   npx tsx --conditions=import scripts/export-run-markdown.ts --case abb-rack-pdu
//   npx tsx --conditions=import scripts/export-run-markdown.ts --run <run-id>

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config as loadEnv } from "dotenv";
import type {
  Case,
  DecisionContent,
  EvidenceContent,
  EvidenceSourceLink,
  HypothesisContent,
  Run,
  Source,
  TreeNode,
} from "../lib/schema";

loadEnv({ path: ".env.local" });

interface Args {
  caseConfigId: string;
  runId?: string;
  out?: string;
}

interface EvidenceLinkWithSource {
  link: EvidenceSourceLink;
  source?: Source;
}

async function main() {
  const [{ insforge }, { loadCase }] = await Promise.all([
    import("../lib/db"),
    import("../lib/framework-registry"),
  ]);

  const args = parseArgs(process.argv.slice(2));
  const caseConfig = loadCase(args.caseConfigId);

  const run = args.runId
    ? await fetchRunById(insforge, args.runId)
    : await fetchLatestRunForCaseTitle(insforge, caseConfig.title);
  const dbCase = await fetchCase(insforge, run.case_id);
  const nodes = await fetchNodes(insforge, run.case_id);
  const linksByEvidenceId = await fetchEvidenceLinks(insforge, run.case_id);

  const report = renderReport({
    caseConfigId: args.caseConfigId,
    dbCase,
    run,
    nodes,
    linksByEvidenceId,
  });

  const outPath =
    args.out ??
    join(
      "docs",
      `${args.caseConfigId}-run-${run.id.slice(0, 8)}.md`,
    );
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, report, "utf8");

  console.log(`Wrote ${outPath}`);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { caseConfigId: "abb-rack-pdu" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--case" && argv[i + 1]) {
      args.caseConfigId = argv[++i];
    } else if (arg === "--run" && argv[i + 1]) {
      args.runId = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = argv[++i];
    } else if (!arg.startsWith("--")) {
      args.caseConfigId = arg;
    }
  }
  return args;
}

async function fetchRunById(
  insforge: typeof import("../lib/db").insforge,
  runId: string,
): Promise<Run> {
  const { data, error } = await insforge.database
    .from("runs")
    .select("*")
    .eq("id", runId)
    .limit(1);
  if (error) throw new Error(`fetchRunById: ${error.message}`);
  const run = (data as Run[] | null)?.[0];
  if (!run) throw new Error(`Run not found: ${runId}`);
  return run;
}

async function fetchLatestRunForCaseTitle(
  insforge: typeof import("../lib/db").insforge,
  title: string,
): Promise<Run> {
  const { data: caseRows, error: caseErr } = await insforge.database
    .from("cases")
    .select("*")
    .eq("title", title)
    .limit(1);
  if (caseErr) throw new Error(`fetchLatestRun case: ${caseErr.message}`);
  const dbCase = (caseRows as Case[] | null)?.[0];
  if (!dbCase) throw new Error(`Case not found in DB: ${title}`);

  const { data: runRows, error: runErr } = await insforge.database
    .from("runs")
    .select("*")
    .eq("case_id", dbCase.id);
  if (runErr) throw new Error(`fetchLatestRun runs: ${runErr.message}`);

  const runs = ((runRows as Run[] | null) ?? []).sort((a, b) =>
    b.started_at.localeCompare(a.started_at),
  );
  const run = runs[0];
  if (!run) throw new Error(`No runs found for case: ${title}`);
  return run;
}

async function fetchCase(
  insforge: typeof import("../lib/db").insforge,
  caseId: string,
): Promise<Case> {
  const { data, error } = await insforge.database
    .from("cases")
    .select("*")
    .eq("id", caseId)
    .limit(1);
  if (error) throw new Error(`fetchCase: ${error.message}`);
  const dbCase = (data as Case[] | null)?.[0];
  if (!dbCase) throw new Error(`Case not found: ${caseId}`);
  return dbCase;
}

async function fetchNodes(
  insforge: typeof import("../lib/db").insforge,
  caseId: string,
): Promise<TreeNode[]> {
  const { data, error } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", caseId);
  if (error) throw new Error(`fetchNodes: ${error.message}`);
  return (data as TreeNode[] | null) ?? [];
}

async function fetchEvidenceLinks(
  insforge: typeof import("../lib/db").insforge,
  caseId: string,
): Promise<Map<string, EvidenceLinkWithSource[]>> {
  const { data: sourceRows, error: sourceErr } = await insforge.database
    .from("sources")
    .select("*")
    .eq("case_id", caseId);
  if (sourceErr) throw new Error(`fetchEvidenceLinks sources: ${sourceErr.message}`);

  const sources = (sourceRows as Source[] | null) ?? [];
  const sourceIds = new Set(sources.map((s) => s.id));
  const sourcesById = new Map(sources.map((s) => [s.id, s]));

  const { data: linkRows, error: linkErr } = await insforge.database
    .from("evidence_sources")
    .select("*");
  if (linkErr) throw new Error(`fetchEvidenceLinks links: ${linkErr.message}`);

  const linksByEvidenceId = new Map<string, EvidenceLinkWithSource[]>();
  for (const link of (linkRows as EvidenceSourceLink[] | null) ?? []) {
    if (!sourceIds.has(link.source_id)) continue;
    const existing = linksByEvidenceId.get(link.evidence_node_id) ?? [];
    existing.push({ link, source: sourcesById.get(link.source_id) });
    linksByEvidenceId.set(link.evidence_node_id, existing);
  }
  return linksByEvidenceId;
}

function renderReport(input: {
  caseConfigId: string;
  dbCase: Case;
  run: Run;
  nodes: TreeNode[];
  linksByEvidenceId: Map<string, EvidenceLinkWithSource[]>;
}): string {
  const childrenByParentId = groupChildren(input.nodes);
  const decision = input.nodes.find((n) => n.type === "decision");
  const hypotheses = input.nodes
    .filter((n) => n.type === "hypothesis")
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

  const lines: string[] = [];
  lines.push(`# ${input.dbCase.title}`);
  lines.push("");
  lines.push(`**Case config:** \`${input.caseConfigId}\``);
  lines.push(`**Question:** ${input.dbCase.question}`);
  lines.push(`**Run:** \`${input.run.id}\` (${input.run.status})`);
  lines.push(`**Started:** ${formatDate(input.run.started_at)}`);
  if (input.run.completed_at) lines.push(`**Completed:** ${formatDate(input.run.completed_at)}`);
  if (input.run.error) lines.push(`**Run error:** ${input.run.error}`);
  lines.push("");

  lines.push("## Decision");
  lines.push("");
  if (decision?.type === "decision") {
    const content = decision.content as DecisionContent;
    lines.push(`**Decision:** ${content.finalDecision}`);
    lines.push(`**Confidence:** ${formatConfidence(decision.confidence)}`);
    const weakestLabel =
      content.weakestLinkLabel ??
      input.nodes.find((n) => n.id === content.weakestLinkNodeId)?.label ??
      content.weakestLinkNodeId;
    lines.push(`**Weakest link:** ${weakestLabel}`);
    lines.push("");
    lines.push(content.reasoning || "_No reasoning captured._");
    lines.push("");
    const gapGroups = aggregateGapsForExport(input.nodes, hypotheses);
    if (gapGroups.length > 0) {
      lines.push("**Diligence gaps to close:**");
      for (const group of gapGroups) {
        lines.push(`- _${group.parentLabel}_`);
        for (const action of group.actions) {
          lines.push(`  - ${action}`);
        }
      }
      lines.push("");
    }

    lines.push("**Thresholds:**");
    if (content.thresholds && Object.keys(content.thresholds).length > 0) {
      const labelById = new Map(input.nodes.map((n) => [n.id, n.label]));
      for (const [key, record] of Object.entries(content.thresholds)) {
        const observed = formatThresholdObserved(record);
        const sources = record.sourceLeafIds
          .map((id) => labelById.get(id) ?? id)
          .join(", ");
        const sourceSuffix = sources ? ` (see ${sources})` : "";
        lines.push(
          `- ${key}: target ${record.target} / observed ${observed}${sourceSuffix}`,
        );
      }
    } else {
      for (const [key, value] of Object.entries(content.thresholdsMet)) {
        lines.push(`- ${key}: ${value ? "met" : "not met"}`);
      }
    }
  } else {
    lines.push("_No decision node found._");
  }
  lines.push("");

  lines.push("## Hypotheses");
  lines.push("");
  for (const hypothesis of hypotheses) {
    renderHypothesisSection(lines, hypothesis, childrenByParentId, input.linksByEvidenceId, 3);
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderHypothesisSection(
  lines: string[],
  node: TreeNode,
  childrenByParentId: Map<string, TreeNode[]>,
  linksByEvidenceId: Map<string, EvidenceLinkWithSource[]>,
  headingLevel: number,
) {
  if (node.type !== "hypothesis" && node.type !== "sub_hypothesis") return;

  const content = node.content as HypothesisContent;
  lines.push(`${"#".repeat(headingLevel)} ${node.label}`);
  lines.push("");
  lines.push(`**Confidence:** ${formatConfidence(node.confidence)}`);
  if (node.weight !== null) lines.push(`**Weight:** ${formatPercent(Number(node.weight))}`);
  lines.push(`**Status:** ${node.status}`);
  if (node.model_used) lines.push(`**Model:** ${node.model_used}`);
  lines.push("");
  lines.push(`**Claim:** ${content.claim}`);
  lines.push(`**Falsifier:** ${content.falsifier}`);
  lines.push(`**Test:** ${formatTest(content.test)}`);
  lines.push(`**Mode dependence:** ${content.modeDependence}`);
  lines.push(`**Insight at stake:** ${content.insightAtStake}`);
  if (content.rationale) {
    lines.push("");
    lines.push(`**Rationale:** ${content.rationale}`);
  }
  lines.push("");

  const children = childrenByParentId.get(node.id) ?? [];
  const evidence = children.filter((child) => child.type === "evidence");
  if (evidence.length > 0) {
    lines.push("**Evidence:**");
    for (const evidenceNode of evidence) {
      renderEvidence(lines, evidenceNode, linksByEvidenceId);
    }
    lines.push("");
  }

  const subHypotheses = children
    .filter((child) => child.type === "sub_hypothesis")
    .sort((a, b) => a.label.localeCompare(b.label));
  for (const sub of subHypotheses) {
    renderHypothesisSection(lines, sub, childrenByParentId, linksByEvidenceId, headingLevel + 1);
  }
}

function renderEvidence(
  lines: string[],
  node: TreeNode,
  linksByEvidenceId: Map<string, EvidenceLinkWithSource[]>,
) {
  if (node.type !== "evidence") return;
  const content = node.content as EvidenceContent;
  const strengthLabel =
    content.rawStrength && content.rawStrength !== content.strength
      ? `${content.strength} (was ${content.rawStrength} pre-stake)`
      : content.strength;
  const stakeLabel =
    content.sourceStake && content.sourceStake !== "third-party"
      ? `source: ${content.sourceStake}`
      : undefined;
  const badges = [
    content.supports,
    strengthLabel,
    stakeLabel,
    node.model_used ? `model: ${node.model_used}` : undefined,
  ].filter(Boolean);

  lines.push(`- **${badges.join(" / ")}:** ${content.finding}`);
  if (content.sourceQuote) lines.push(`  - Quote: "${content.sourceQuote}"`);

  const links = linksByEvidenceId.get(node.id) ?? [];
  for (const { link, source } of links.slice(0, 2)) {
    const title = source?.title || source?.uri || "source";
    const page = link.page_number ? `, page ${link.page_number}` : "";
    lines.push(`  - Source: ${title}${page}`);
    if (link.quote && link.quote !== content.sourceQuote) {
      lines.push(`  - Source quote: "${link.quote}"`);
    }
  }
}

function groupChildren(nodes: TreeNode[]): Map<string, TreeNode[]> {
  const out = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (!node.parent_id) continue;
    const children = out.get(node.parent_id) ?? [];
    children.push(node);
    out.set(node.parent_id, children);
  }
  return out;
}

function aggregateGapsForExport(
  nodes: TreeNode[],
  hypotheses: TreeNode[],
): { parentLabel: string; actions: string[] }[] {
  const childrenByParent = groupChildren(nodes);
  const groups: { parentLabel: string; actions: string[] }[] = [];
  for (const parent of hypotheses) {
    const subs = (childrenByParent.get(parent.id) ?? []).filter(
      (n) => n.type === "sub_hypothesis",
    );
    const actions: string[] = [];
    for (const sub of subs) {
      const action = (sub.content as HypothesisContent).gapClosingAction;
      if (action && !actions.includes(action)) actions.push(action);
    }
    if (actions.length > 0) {
      groups.push({ parentLabel: parent.label, actions });
    }
  }
  return groups;
}

function formatThresholdObserved(record: {
  observed: number | string | null;
  status: "met" | "not-met" | "not-directly-tested" | "partially-tested";
}): string {
  if (record.observed !== null && record.observed !== undefined) {
    return `${record.observed} (${record.status})`;
  }
  switch (record.status) {
    case "not-directly-tested":
      return "not directly tested";
    case "partially-tested":
      return "partially tested";
    case "met":
      return "met";
    case "not-met":
      return "not met";
  }
}

function formatTest(test: HypothesisContent["test"]): string {
  const horizon = test.horizon ? ` over ${test.horizon}` : "";
  return `${test.type} on ${test.metric}; target ${String(test.target)}${horizon}`;
}

function formatConfidence(value: number | null): string {
  if (value === null || Number.isNaN(Number(value))) return "n/a";
  return `${formatPercent(Number(value))} (${Number(value).toFixed(3)})`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

main().catch((e) => {
  console.error("export-run-markdown failed:", e);
  process.exit(1);
});
