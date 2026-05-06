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
  MickyOutput,
  MickyRun,
  Run,
  Source,
  TreeNode,
} from "../lib/schema";
import type { Framework } from "../lib/framework-registry";

loadEnv({ path: ".env.local" });

interface Args {
  caseConfigId: string;
  runId?: string;
  out?: string;
  stripSourceBias: boolean;
}

interface EvidenceLinkWithSource {
  link: EvidenceSourceLink;
  source?: Source;
}

async function main() {
  const [{ insforge }, { loadCase, loadFramework }] = await Promise.all([
    import("../lib/db"),
    import("../lib/framework-registry"),
  ]);

  const args = parseArgs(process.argv.slice(2));
  const caseConfig = loadCase(args.caseConfigId);
  const framework = loadFramework(caseConfig.frameworkId);

  const run = args.runId
    ? await fetchRunById(insforge, args.runId)
    : await fetchLatestRunForCaseTitle(insforge, caseConfig.title);
  const dbCase = await fetchCase(insforge, run.case_id);
  const nodes = await fetchNodes(insforge, run.case_id);
  const sources = await fetchSources(insforge, run.case_id);
  const linksByEvidenceId = await fetchEvidenceLinks(insforge, run.case_id);
  const mickyRun = await fetchLatestCompleteMickyRun(insforge, run.id);

  const report = renderReport({
    caseConfigId: args.caseConfigId,
    dbCase,
    run,
    nodes,
    sources,
    linksByEvidenceId,
    mickyOutput: mickyRun?.output ?? null,
    stripSourceBias: args.stripSourceBias,
    framework,
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
  const args: Args = { caseConfigId: "abb-rack-pdu", stripSourceBias: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--case" && argv[i + 1]) {
      args.caseConfigId = argv[++i];
    } else if (arg === "--run" && argv[i + 1]) {
      args.runId = argv[++i];
    } else if (arg === "--out" && argv[i + 1]) {
      args.out = argv[++i];
    } else if (arg === "--no-strip-bias") {
      args.stripSourceBias = false;
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

async function fetchSources(
  insforge: typeof import("../lib/db").insforge,
  caseId: string,
): Promise<Source[]> {
  const { data, error } = await insforge.database
    .from("sources")
    .select("*")
    .eq("case_id", caseId);
  if (error) throw new Error(`fetchSources: ${error.message}`);
  return (data as Source[] | null) ?? [];
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

async function fetchLatestCompleteMickyRun(
  insforge: typeof import("../lib/db").insforge,
  runId: string,
): Promise<MickyRun | null> {
  const { data, error } = await insforge.database
    .from("micky_runs")
    .select("*")
    .eq("run_id", runId)
    .eq("status", "complete")
    .is("deleted_at", null);
  if (error) throw new Error(`fetchMickyRun: ${error.message}`);
  const runs = ((data as MickyRun[] | null) ?? []).sort(
    (a, b) => b.attempt_number - a.attempt_number,
  );
  return runs[0] ?? null;
}

function renderReport(input: {
  caseConfigId: string;
  dbCase: Case;
  run: Run;
  nodes: TreeNode[];
  sources: Source[];
  linksByEvidenceId: Map<string, EvidenceLinkWithSource[]>;
  mickyOutput: MickyOutput | null;
  stripSourceBias: boolean;
  framework: Framework;
}): string {
  const childrenByParentId = groupChildren(input.nodes);
  const decision = input.nodes.find((n) => n.type === "decision");
  const hypotheses = input.nodes
    .filter((n) => n.type === "hypothesis")
    .sort((a, b) => (Number(b.weight) || 0) - (Number(a.weight) || 0));

  const slotById = buildSlotIndex(input.framework);

  const lines: string[] = [];
  if (input.mickyOutput) {
    lines.push("---");
    lines.push("ai_generated: true");
    lines.push("---");
    lines.push("");
  }
  lines.push(`# ${input.dbCase.title}`);
  lines.push("");
  lines.push(`**Case config:** \`${input.caseConfigId}\``);
  lines.push(`**Question:** ${input.dbCase.question}`);
  lines.push(`**Run:** \`${input.run.id}\` (${input.run.status})`);
  lines.push(`**Started:** ${formatDate(input.run.started_at)}`);
  if (input.run.completed_at) lines.push(`**Completed:** ${formatDate(input.run.completed_at)}`);
  if (input.run.error) lines.push(`**Run error:** ${input.run.error}`);
  lines.push(
    `**Framework:** ${input.framework.name} (\`${input.framework.id}\`) — Tier 1 of ${input.framework.tiers.length}`,
  );
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
    lines.push(formatTier2GateLine(input.framework, decision.confidence, content));
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

  if (input.mickyOutput) {
    renderMickyMemoSection(
      lines,
      input.mickyOutput,
      input.sources,
      input.stripSourceBias,
    );
  }

  lines.push("## Hypotheses");
  lines.push("");
  for (const hypothesis of hypotheses) {
    renderHypothesisSection(
      lines,
      hypothesis,
      childrenByParentId,
      input.linksByEvidenceId,
      3,
      input.mickyOutput,
      slotById,
    );
  }

  return `${lines.join("\n").trim()}\n`;
}

function renderHypothesisSection(
  lines: string[],
  node: TreeNode,
  childrenByParentId: Map<string, TreeNode[]>,
  linksByEvidenceId: Map<string, EvidenceLinkWithSource[]>,
  headingLevel: number,
  mickyOutput: MickyOutput | null = null,
  slotById: Map<string, SlotIndexEntry> = new Map(),
) {
  if (node.type !== "hypothesis" && node.type !== "sub_hypothesis") return;

  const content = node.content as HypothesisContent;
  lines.push(`${"#".repeat(headingLevel)} ${node.label}`);
  lines.push("");
  const slotLine = formatSlotLine(node.type, content, node.weight, slotById);
  if (slotLine) lines.push(slotLine);
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
  const mickyNote = mickyOutput?.hypothesisRanking.find(
    (e) => rankingId(e) === node.id,
  );
  const mickyDecomp = mickyOutput?.hypothesisDecomposition.find(
    (e) => decompId(e) === node.id,
  );
  if (mickyNote) {
    lines.push("");
    lines.push(`**Micky's note:** ${rankingRationale(mickyNote)}`);
    if (mickyDecomp && mickyDecomp.whatWasCut.length > 0) {
      lines.push("**Micky considered but cut:**");
      renderCutBuckets(lines, mickyDecomp.whatWasCut);
      lines.push(`**Micky decomposition note:** ${decompRationale(mickyDecomp)}`);
    }
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
    renderHypothesisSection(
      lines,
      sub,
      childrenByParentId,
      linksByEvidenceId,
      headingLevel + 1,
      mickyOutput,
      slotById,
    );
  }
}

function renderMickyMemoSection(
  lines: string[],
  output: MickyOutput,
  sources: Source[],
  stripSourceBias: boolean,
) {
  const scrub = (value: string) =>
    polishMemoText(stripSourceBias ? stripBiasNearSources(value, sources) : value);

  lines.push("## Micky's Memo");
  lines.push("");
  lines.push("_AI-generated · Micky_");
  lines.push("");
  if (output.reframe) {
    lines.push("### The reframe");
    lines.push("");
    lines.push(`**${scrub(output.reframe.headline)}**`);
    lines.push("");
    lines.push(scrub(output.reframe.reasoning));
    lines.push("");
  }

  lines.push("### Recommendation");
  lines.push("");
  lines.push(scrub(output.recommendation.oneLiner));
  lines.push("");
  lines.push(`- Weakest link: ${scrub(output.recommendation.weakestLink)}`);
  lines.push(`- What would flip it: ${scrub(output.recommendation.whatWouldFlipIt)}`);
  lines.push("");

  lines.push("### Framework rationale");
  lines.push("");
  lines.push(scrub(output.frameworkRationale.chosen));
  for (const rejected of output.frameworkRationale.rejected) {
    lines.push(`  - _${scrub(rejected.name)}: ${scrub(rejected.whyCut)}_`);
  }
  lines.push("");

  if (output.hypothesisRanking.length > 0) {
    lines.push("### Binding constraints");
    lines.push("");
    for (const entry of [...output.hypothesisRanking].sort((a, b) => a.rank - b.rank)) {
      lines.push(
        `- **${entry.rank} · ${scrub(rankingLabel(entry))}:** ${scrub(rankingRationale(entry))}`,
      );
    }
    lines.push("");
  }

  if (output.hypothesisDecomposition.length > 0) {
    lines.push("### Hypothesis decomposition");
    lines.push("");
    for (const entry of output.hypothesisDecomposition) {
      lines.push(`#### ${scrub(decompLabel(entry))}`);
      lines.push("");
      lines.push(scrub(decompRationale(entry)));
      renderCutBuckets(lines, entry.whatWasCut);
      lines.push("");
    }
    lines.push("");
  }

  if (output.judgmentCalls.length > 0) {
    lines.push("### Judgment calls");
    lines.push("");
    for (const item of output.judgmentCalls) {
      lines.push(`- **${scrub(item.area)}:** ${scrub(item.thinness)}`);
      lines.push(`  - _${scrub(item.whyIWentThere)}_`);
    }
    lines.push("");
  }

  if (output.pushback.length > 0) {
    lines.push("### How I'd push back on this memo");
    lines.push("");
    for (const item of output.pushback) lines.push(`- ${scrub(item.challenge)}`);
    lines.push("");
  }

  lines.push(`— MB · ${output.signOff.date}`);
  lines.push("");
  lines.push("_This memo was generated by an AI system. It is not the work of a human partner._");
  lines.push("_This AI-generated memo is decision support only and does not constitute professional consulting, legal, or financial advice. Apply independent judgment before acting._");
  lines.push("");
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

interface SlotIndexEntry {
  slotId: string;
  tierLabel: string;
  parentSlotId?: string;
  parentWeight?: number;
}

function buildSlotIndex(framework: Framework): Map<string, SlotIndexEntry> {
  const out = new Map<string, SlotIndexEntry>();
  const tier1 = framework.tiers[0];
  const tierLabel = "Tier 1";
  for (const slot of tier1.slots) {
    out.set(slot.id, { slotId: slot.id, tierLabel });
    for (const sub of slot.decomposition ?? []) {
      out.set(sub.id, {
        slotId: sub.id,
        tierLabel,
        parentSlotId: slot.id,
        parentWeight: slot.weight,
      });
    }
  }
  return out;
}

function formatSlotLine(
  nodeType: "hypothesis" | "sub_hypothesis",
  content: HypothesisContent,
  nodeWeight: number | null,
  slotById: Map<string, SlotIndexEntry>,
): string | null {
  if (!content.templateId) return null;
  const entry = slotById.get(content.templateId);
  if (!entry) return null;
  const parts: string[] = [entry.tierLabel];
  if (nodeType === "hypothesis" && nodeWeight !== null && !Number.isNaN(Number(nodeWeight))) {
    parts.push(`weight ${formatPercent(Number(nodeWeight))}`);
  } else if (nodeType === "sub_hypothesis" && entry.parentSlotId) {
    parts.push(`under \`${entry.parentSlotId}\``);
  }
  return `**Slot:** \`${entry.slotId}\` (${parts.join(" · ")})`;
}

function formatTier2GateLine(
  framework: Framework,
  rolledConfidence: number | null,
  decisionContent: DecisionContent,
): string {
  const tier2 = framework.tiers[1];
  // activatesIf is shaped like "tier-1.confidence > 0.6"; pull the rightmost
  // numeric literal so the "1" in "tier-1" doesn't shadow the real gate.
  const gateMatch = /([0-9]*\.?[0-9]+)\s*$/.exec(tier2.activatesIf.trim());
  const gate = gateMatch ? Number(gateMatch[1]) : 0.6;
  const optionsLabel = tier2.options
    .map((o) => o.charAt(0).toUpperCase() + o.slice(1))
    .join(" / ");
  const conf =
    typeof rolledConfidence === "number" && !Number.isNaN(rolledConfidence)
      ? rolledConfidence.toFixed(3)
      : "n/a";
  if (decisionContent.tier2) {
    const recommendation = decisionContent.tier2.recommendedOption.toUpperCase();
    return `**Tier 2 (${optionsLabel}):** activated at confidence ${conf} ≥ ${gate.toFixed(2)}. Recommendation: ${recommendation}.`;
  }
  return `**Tier 2 (${optionsLabel}):** not activated — Tier 1 confidence ${conf} < ${gate.toFixed(2)} gate.`;
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

function rankingId(entry: MickyOutput["hypothesisRanking"][number]): string {
  return entry.hypothesisId ?? (entry as unknown as { id?: string }).id ?? "";
}

function rankingLabel(entry: MickyOutput["hypothesisRanking"][number]): string {
  return entry.hypothesisLabel ?? "(unlabeled hypothesis)";
}

function rankingRationale(
  entry: MickyOutput["hypothesisRanking"][number],
): string {
  return entry.rationale ?? (entry as unknown as { whyThisRank?: string }).whyThisRank ?? "";
}

function decompId(
  entry: MickyOutput["hypothesisDecomposition"][number],
): string {
  return entry.hypothesisId ?? (entry as unknown as { hypId?: string }).hypId ?? "";
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

function renderCutBuckets(
  lines: string[],
  items: MickyOutput["hypothesisDecomposition"][number]["whatWasCut"],
) {
  const normalized = (items as Array<string | { type?: string; name: string; whyCut?: string }>).map(
    (item) =>
      typeof item === "string"
        ? { type: "hypothesis", name: item, whyCut: "" }
        : item,
  );
  const buckets = [
    ["hypothesis", "Cut hypotheses"],
    ["method", "Methods not used"],
    ["scope", "Scope choices"],
  ] as const;
  for (const [type, label] of buckets) {
    const bucket = normalized.filter((item) => item.type === type);
    if (bucket.length === 0) continue;
    const rendered = bucket
      .map((item) =>
        item.whyCut ? `  - ${item.name} - ${polishMemoText(item.whyCut)}` : `  - ${item.name}`,
      )
      .join("\n");
    lines.push("");
    lines.push(`_${label}_`);
    lines.push(rendered);
  }
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

const BIAS_TOKENS = [
  "pre-disposed",
  "biased",
  "de-rated",
  "discounted",
  "conflict-of-interest",
];

const BIAS_NOTE =
  "Note: one or more sources was flagged as potentially predisposed; findings from those sources were weighted accordingly.";

export function stripBiasNearSources(value: string, sources: Source[]): string {
  let out = value;
  const labels = sources
    .flatMap((source) => [source.title, source.metadata?.author, source.uri])
    .filter((label): label is string => Boolean(label && label.trim().length > 2));

  for (const label of labels) {
    const labelRe = escapeRegex(label);
    const tokenRe = BIAS_TOKENS.map(escapeRegex).join("|");
    const sourceThenBias = new RegExp(
      `[^.\\n]{0,80}${labelRe}[^.\\n]{0,80}(${tokenRe})[^.\\n]{0,80}`,
      "gi",
    );
    const biasThenSource = new RegExp(
      `[^.\\n]{0,80}(${tokenRe})[^.\\n]{0,80}${labelRe}[^.\\n]{0,80}`,
      "gi",
    );
    out = out.replace(sourceThenBias, BIAS_NOTE).replace(biasThenSource, BIAS_NOTE);
  }
  return out;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

main().catch((e) => {
  console.error("export-run-markdown failed:", e);
  process.exit(1);
});
