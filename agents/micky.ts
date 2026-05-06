import { insforge } from "@/lib/db";
import { completeJson, type Message } from "@/lib/llm-client";
import type {
  Case,
  ConsideredAlternative,
  DecisionContent,
  HypothesisContent,
  MickyOutput,
  MickyReframe,
  MickyRun,
  ParsedBrief,
  TreeNode,
} from "@/lib/schema";
import { parseBrief } from "./brief-parser";
import { bindFramework, type FrameworkBinding } from "./framework-binder";

export const MICKY_REFRAME_SYSTEM_PROMPT = [
  "You are Micky, an AI-generated senior-partner style reviewer.",
  "Your job is to test whether the case question is still well-posed after the analysis is complete.",
  "",
  "DO NOT use these words: delve, tapestry, robust, comprehensive, multifaceted.",
  "Prefer short sentences and fragments over subordinate clauses.",
  'Positive style example: "Two things stand out. One: market is real. Two: timing isn\'t."',
  "",
  "You may disagree with the tree's recommendation. If you do, say so directly.",
  "Ask: in light of what the tree found, are we answering the right question?",
  "If the findings show the decision cannot be made because a prior diligence step is missing, reframe.",
  "Example: if the brief asks whether to enter but the analysis shows no financial model exists, the real question is pre-decision diligence.",
  "The reframe must contradict an assumption embedded in the brief, not restate the brief in better language.",
  "If you cannot identify an assumption to challenge, return null.",
  "A good reframe is declarative and slightly jarring. Bad: \"Pre-decision diligence question: Can X clear thresholds?\" Good: \"You asked for market entry; the financial case has not been built.\"",
  "If the question is still well-posed, return null. Do not force a reframe.",
  "",
  "Return JSON only: { \"reframe\": null } or",
  "{ \"reframe\": { \"headline\": \"...\", \"reasoning\": \"...\" } }.",
].join("\n");

export const MICKY_MEMO_SYSTEM_PROMPT = [
  "You are Micky, an AI-generated senior-partner style memo writer.",
  "You read the completed decision tree, then write the partner note the team wishes it had before the meeting.",
  "",
  "DO NOT use these words: delve, tapestry, robust, comprehensive, multifaceted.",
  "Prefer short sentences and fragments over subordinate clauses.",
  'Positive style example: "Two things stand out. One: market is real. Two: timing isn\'t."',
  "",
  "Specificity rule: name the specific data point, document, or year that makes a claim thin.",
  'Positive: "Confidence on H2 is thin because the parity-cost data is from 2022"',
  'Negative: "there is some uncertainty around competitive positioning"',
  "",
  "You may disagree with the tree's recommendation. If you do, say so directly.",
  "Judgment calls must name both the thinness and what evidence would resolve it.",
  "Protect this formula: name the thinness, then name what would resolve it.",
  "Pushback is required: include 2-3 challenges a skeptical reader should raise.",
  "",
  "Do not expose implementation machinery. Never say Agent Victor, tree machinery, hypothesis-weighted confidence tree, mode-conditional sub-hypotheses, internal architecture, or UUID.",
  "Framework rationale must name the strategic frame a human would recognize. Use the chosen framework name supplied by the user prompt.",
  "Never include framework ids, YAML filenames, UUIDs, or parenthetical internal identifiers in the memo.",
  "If no rejected frameworks were logged upstream, return frameworkRationale.rejected as [] and do not invent plausible alternatives.",
  "Do not call analytical methods or scope exclusions rejected hypotheses. Keep cut items typed as hypothesis, method, or scope.",
  "Hypothesis ranking must cover ONLY the top-level hypotheses supplied in the Top-level hypothesis outcomes block. Do not rank sub-hypotheses.",
  "Hypothesis ranking is a binding-constraint ranking: highest decision risk first, not strongest-evidence first.",
  "Use the short displayLabel as hypothesisLabel. Do not use the full claim unless no displayLabel exists.",
  "Hypothesis decomposition must cover ONLY those same top-level hypotheses. Use sub-hypotheses as evidence inside the rationale.",
  "Each hypothesisDecomposition.rationale must be no more than four sentences: split, strongest sub-hypothesis, weakest sub-hypothesis, gap-closing action.",
  "Across all generated prose, mention numeric confidence scores at most three times total. Reserve them for weakest-link or pivotal sub-hypotheses. Everywhere else, translate scores into qualitative language.",
  "Never put numeric confidence scores inside hypothesisRanking.rationale or hypothesisDecomposition.rationale. Use words like near-floor, weak, mixed, credible, or strongest instead.",
  "",
  "Few-shot example:",
  "Recommendation: I would not green-light this yet. The market is plausible. The proof is not. Weakest link is pricing power. I would flip if three enterprise buyers show contracted willingness above the current parity band.",
  "Judgment call: I gave the supply-chain concern less weight. Thinness: the only lead-time evidence is a 2023 supplier memo. I went there because the customer interviews point to uptime pain, not procurement pain. A fresh distributor quote would settle it.",
  "Considered but cut: Build-first. Too slow for the window. Partner-first stays alive.",
  "Sign-off: MB",
  "",
  "Return JSON only with the exact MickyOutput shape supplied in the user prompt.",
].join("\n");

export interface MickyContext {
  caseId: string;
  runId: string;
  caseTitle: string;
  caseQuestion: string;
  parsedBrief: ParsedBrief;
  frameworkBinding: FrameworkBinding;
  tree: TreeNode[];
}

interface MickyAttempt {
  id: string;
  attemptNumber: number;
}

export async function startMickyAttempt(runId: string): Promise<MickyAttempt> {
  const attemptNumber = await nextAttemptNumber(runId);
  const { data, error } = await insforge.database
    .from("micky_runs")
    .insert([{ run_id: runId, attempt_number: attemptNumber, status: "running" }])
    .select();
  if (error) throw new Error(`micky_runs insert: ${error.message}`);
  const row = (data as MickyRun[] | null)?.[0];
  if (!row) throw new Error("micky_runs insert returned no row");
  return { id: row.id, attemptNumber: row.attempt_number };
}

export async function runReframe(
  context: MickyContext,
): Promise<MickyReframe | null> {
  const messages: Message[] = [
    { role: "system", content: MICKY_REFRAME_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Case question: ${context.caseQuestion}`,
        "",
        `Info gaps: ${JSON.stringify(context.parsedBrief.infoGaps)}`,
        `Risks: ${JSON.stringify(context.parsedBrief.risks)}`,
        "",
        "Decision and weakest-link context:",
        JSON.stringify(buildDecisionContext(context), null, 2),
        "",
        "Top-level hypothesis outcomes:",
        JSON.stringify(summarizeTopLevelHypotheses(context), null, 2),
        "",
        "If the question is well-posed, return null. Do not force a reframe.",
      ].join("\n"),
    },
  ];

  const parsed = await completeJson<{ reframe: MickyReframe | null }>(
    "micky",
    messages,
    { temperature: 0.7 },
  );
  if (parsed.reframe === null) return null;
  if (!isMickyReframe(parsed.reframe)) return null;
  return parsed.reframe;
}

export async function runMemoSynthesizer(
  context: MickyContext,
  reframe: MickyReframe | null,
): Promise<MickyOutput> {
  const messages: Message[] = [
    { role: "system", content: MICKY_MEMO_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Case: ${context.caseTitle}`,
        `Question: ${context.caseQuestion}`,
        `Today: ${new Date().toISOString().slice(0, 10)}`,
        `Reframe: ${JSON.stringify(reframe)}`,
        `Chosen strategic framework: ${context.frameworkBinding.framework.name}`,
        "",
        "Tree summary:",
        JSON.stringify(summarizeTree(context), null, 2),
        "",
        "Top-level hypothesis outcomes:",
        JSON.stringify(summarizeTopLevelHypotheses(context), null, 2),
        "",
        "Rejected alternatives:",
        JSON.stringify(extractAlternatives(context), null, 2),
        "",
        "Return JSON with this exact TypeScript shape:",
        "{",
        "  reframe: MickyReframe | null;",
        "  recommendation: { oneLiner: string; weakestLink: string; whatWouldFlipIt: string };",
        "  frameworkRationale: { chosen: string; rejected: { type: \"framework\"; name: string; whyCut: string }[] };",
        "  hypothesisRanking: { hypothesisId: string; hypothesisLabel: string; rank: number; rationale: string }[];",
        "  hypothesisDecomposition: { hypothesisId: string; hypothesisLabel: string; rationale: string; whatWasCut: { type: \"hypothesis\" | \"method\" | \"scope\"; name: string; whyCut: string }[] }[];",
        "  judgmentCalls: { area: string; thinness: string; whyIWentThere: string }[];",
        "  pushback: { challenge: string }[];",
        "  signOff: { date: string; monogram: \"MB\" };",
        "}",
        "Use the Today value for signOff.date.",
      ].join("\n"),
    },
  ];

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const output = await completeJson<MickyOutput>("micky", messages, {
      temperature: attempt === 0 ? 0.55 : 0.35,
      maxTokens: 5000,
    });
    try {
      assertMickyOutput(output);
      return output;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      messages.push({
        role: "user",
        content: [
          `The previous JSON failed validation: ${lastError.message}.`,
          "Regenerate the full JSON object, not a patch.",
          "Hard constraints:",
          "- Each hypothesisDecomposition.rationale is at most four sentences.",
          "- Numeric confidence scores appear at most three times in all prose.",
          "- No numeric confidence scores appear in ranking or decomposition rationale.",
          "- Hypothesis labels are short display labels, not full claims.",
          "- Framework rationale uses only the human framework name, never ids or parenthetical slugs.",
          "- The reframe must challenge an assumption embedded in the brief or be null.",
        ].join("\n"),
      });
    }
  }
  throw lastError ?? new Error("micky output failed validation");
}

export async function runMicky(
  runId: string,
  caseConfigId: string,
  attempt?: MickyAttempt,
): Promise<MickyOutput> {
  const activeAttempt = attempt ?? (await startMickyAttempt(runId));

  try {
    const context = await buildMickyContext(runId, caseConfigId);
    const reframe = await runReframe(context);
    const output = await runMemoSynthesizer(context, reframe);
    await markAttemptComplete(activeAttempt.id, output);
    return output;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markAttemptFailed(activeAttempt.id, message);
    throw e;
  }
}

async function buildMickyContext(
  runId: string,
  caseConfigId: string,
): Promise<MickyContext> {
  const { data: runRows, error: runErr } = await insforge.database
    .from("runs")
    .select("*")
    .eq("id", runId)
    .limit(1);
  if (runErr) throw new Error(`micky fetch run: ${runErr.message}`);
  const run = (runRows as { case_id: string }[] | null)?.[0];
  if (!run) throw new Error(`micky run not found: ${runId}`);

  const { data: caseRows, error: caseErr } = await insforge.database
    .from("cases")
    .select("*")
    .eq("id", run.case_id)
    .limit(1);
  if (caseErr) throw new Error(`micky fetch case: ${caseErr.message}`);
  const dbCase = (caseRows as Case[] | null)?.[0];
  if (!dbCase) throw new Error(`micky case not found: ${run.case_id}`);

  const { data: nodeRows, error: nodeErr } = await insforge.database
    .from("tree_nodes")
    .select("*")
    .eq("case_id", run.case_id);
  if (nodeErr) throw new Error(`micky fetch tree: ${nodeErr.message}`);

  return {
    caseId: run.case_id,
    runId,
    caseTitle: dbCase.title,
    caseQuestion: dbCase.question,
    parsedBrief: dbCase.brief_extract ?? (await parseBrief(caseConfigId)),
    frameworkBinding: await bindFramework(caseConfigId),
    tree: (nodeRows as TreeNode[] | null) ?? [],
  };
}

async function nextAttemptNumber(runId: string): Promise<number> {
  const { data, error } = await insforge.database
    .from("micky_runs")
    .select("attempt_number")
    .eq("run_id", runId);
  if (error) throw new Error(`micky attempt count: ${error.message}`);
  const attempts = (data as Pick<MickyRun, "attempt_number">[] | null) ?? [];
  return attempts.reduce((max, row) => Math.max(max, row.attempt_number), 0) + 1;
}

async function markAttemptComplete(
  id: string,
  output: MickyOutput,
): Promise<void> {
  const { error } = await insforge.database
    .from("micky_runs")
    .update({
      status: "complete",
      output,
      error: null,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`micky complete update: ${error.message}`);
}

async function markAttemptFailed(id: string, message: string): Promise<void> {
  const { error } = await insforge.database
    .from("micky_runs")
    .update({
      status: "failed",
      error: message,
      completed_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw new Error(`micky failed update: ${error.message}`);
}

function summarizeTree(context: MickyContext) {
  return context.tree.map((node) => ({
    id: node.id,
    parentId: node.parent_id,
    type: node.type,
    label: node.label,
    displayLabel: displayLabelForNode(node, context.frameworkBinding),
    confidenceBand: confidenceBand(node.confidence),
    decisionWeight: weightBand(node.weight),
    content: node.content,
  }));
}

function buildDecisionContext(context: MickyContext) {
  const decision = context.tree.find((node) => node.type === "decision");
  if (!decision || decision.type !== "decision") return null;
  const content = decision.content as DecisionContent;
  const weakestNode = context.tree.find(
    (node) => node.id === content.weakestLinkNodeId,
  );
  return {
    decisionLabel: decision.label,
    finalDecision: content.finalDecision,
    finalDecisionState: content.finalDecisionState,
    reasoning: content.reasoning,
    weakestLinkNodeId: content.weakestLinkNodeId,
    weakestLinkLabel:
      weakestNode && (weakestNode.type === "hypothesis" || weakestNode.type === "sub_hypothesis")
        ? displayLabelForNode(weakestNode, context.frameworkBinding)
        : content.weakestLinkLabel ?? weakestNode?.label ?? null,
    weakestLinkContent: weakestNode?.content ?? null,
  };
}

function summarizeTopLevelHypotheses(context: MickyContext) {
  const decision = context.tree.find((node) => node.type === "decision");
  const hypotheses = context.tree
    .filter((node) => node.type === "hypothesis")
    .filter((node) => !decision || node.parent_id === decision.id);
  const confidenceRanks = new Map(
    [...hypotheses]
      .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1))
      .map((node, index) => [node.id, index + 1]),
  );
  return hypotheses.map((node) => ({
      hypothesisId: node.id,
      hypothesisLabel: displayLabelForNode(node, context.frameworkBinding),
      fullClaim: hypothesisClaimForNode(node),
      confidenceBand: confidenceBand(node.confidence),
      confidenceRank: confidenceRanks.get(node.id),
      decisionWeight: weightBand(node.weight),
      content: node.content,
      children: context.tree
        .filter((child) => child.parent_id === node.id)
        .map((child) => ({
          hypothesisId: child.id,
          hypothesisLabel: displayLabelForNode(child, context.frameworkBinding),
          fullClaim: hypothesisClaimForNode(child),
          confidenceBand: confidenceBand(child.confidence),
          content: child.content,
        })),
    }));
}

function extractAlternatives(context: MickyContext) {
  const decision = context.tree.find((node) => node.type === "decision");
  const hypotheses = context.tree.filter(
    (node) => node.type === "hypothesis" || node.type === "sub_hypothesis",
  );
  return {
    brief: context.parsedBrief.consideredAlternatives ?? [],
    frameworks:
      context.frameworkBinding.framework.consideredAlternatives ??
      context.parsedBrief.consideredFrameworks ??
      [],
    decision:
      decision && "consideredAlternatives" in decision.content
        ? decision.content.consideredAlternatives ?? []
        : [],
    hypotheses: hypotheses.map((node) => ({
      id: node.id,
      label: displayLabelForNode(node, context.frameworkBinding),
      fullClaim: hypothesisClaimForNode(node),
      consideredAlternatives: hypothesisAlternativesForNode(
        node,
        context.frameworkBinding,
      ),
    })),
  };
}

function displayLabelForNode(
  node: TreeNode,
  binding?: FrameworkBinding,
): string {
  if (node.type !== "hypothesis" && node.type !== "sub_hypothesis") {
    return node.label;
  }
  const content = node.content as HypothesisContent;
  return (
    content.displayLabel ??
    frameworkTemplateForNode(node, binding)?.displayLabel ??
    node.label
  );
}

function hypothesisClaimForNode(node: TreeNode): string | null {
  if (node.type !== "hypothesis" && node.type !== "sub_hypothesis") {
    return null;
  }
  return (node.content as HypothesisContent).claim;
}

function confidenceBand(value: number | null): string {
  if (value === null) return "unscored";
  if (value < 0.2) return "near-floor";
  if (value < 0.45) return "weak";
  if (value < 0.65) return "mixed";
  if (value < 0.8) return "credible";
  return "strong";
}

function weightBand(value: number | null): string {
  if (value === null) return "not weighted";
  if (value >= 0.2) return "high";
  if (value >= 0.15) return "medium";
  return "low";
}

function hypothesisAlternativesForNode(
  node: TreeNode,
  binding: FrameworkBinding,
): ConsideredAlternative[] {
  if (node.type !== "hypothesis" && node.type !== "sub_hypothesis") {
    return [];
  }
  const content = node.content as HypothesisContent;
  const logged = content.consideredAlternatives ?? [];
  if (logged.length > 0) return logged;
  return frameworkTemplateForNode(node, binding)?.consideredAlternatives ?? [];
}

function frameworkTemplateForNode(
  node: TreeNode,
  binding?: FrameworkBinding,
) {
  if (!binding || (node.type !== "hypothesis" && node.type !== "sub_hypothesis")) {
    return null;
  }
  const templateId = (node.content as HypothesisContent).templateId;
  if (!templateId) return null;
  for (const slot of binding.slots) {
    if (slot.id === templateId) return slot;
    const sub = slot.decomposition.find((candidate) => candidate.id === templateId);
    if (sub) return sub;
  }
  return null;
}

function assertMickyOutput(output: MickyOutput): void {
  if (!output || typeof output !== "object") {
    throw new Error("micky output missing");
  }
  if (!isNullableReframe(output.reframe)) {
    throw new Error("micky output invalid reframe");
  }
  if (!nonEmpty(output.recommendation?.oneLiner)) {
    throw new Error("micky output missing recommendation.oneLiner");
  }
  if (!nonEmpty(output.recommendation?.weakestLink)) {
    throw new Error("micky output missing recommendation.weakestLink");
  }
  if (!nonEmpty(output.recommendation?.whatWouldFlipIt)) {
    throw new Error("micky output missing recommendation.whatWouldFlipIt");
  }
  if (!output.frameworkRationale || !nonEmpty(output.frameworkRationale.chosen)) {
    throw new Error("micky output missing frameworkRationale.chosen");
  }
  if (containsInternalFrameworkLeak(output.frameworkRationale.chosen)) {
    throw new Error("micky output leaked internal framework machinery");
  }
  if (output.reframe && looksLikeRestatedQuestion(output.reframe.headline)) {
    throw new Error("micky reframe restated the question instead of challenging an assumption");
  }
  if (!Array.isArray(output.frameworkRationale.rejected)) {
    throw new Error("micky output missing frameworkRationale.rejected");
  }
  if (!Array.isArray(output.hypothesisRanking)) {
    throw new Error("micky output missing hypothesisRanking");
  }
  for (const entry of output.hypothesisRanking) {
    if (
      !nonEmpty(entry.hypothesisId) ||
      !nonEmpty(entry.hypothesisLabel) ||
      typeof entry.rank !== "number" ||
      !nonEmpty(entry.rationale)
    ) {
      throw new Error("micky output has malformed hypothesisRanking entry");
    }
    if (entry.hypothesisLabel.length > 60) {
      throw new Error("micky output used a full claim as a ranking label");
    }
    if (containsNumericConfidenceScore(entry.rationale)) {
      throw new Error("micky output used a numeric confidence score in hypothesisRanking");
    }
  }
  if (!Array.isArray(output.hypothesisDecomposition)) {
    throw new Error("micky output missing hypothesisDecomposition");
  }
  for (const entry of output.hypothesisDecomposition) {
    if (
      !nonEmpty(entry.hypothesisId) ||
      !nonEmpty(entry.hypothesisLabel) ||
      !nonEmpty(entry.rationale) ||
      !Array.isArray(entry.whatWasCut)
    ) {
      throw new Error("micky output has malformed hypothesisDecomposition entry");
    }
    if (entry.hypothesisLabel.length > 60) {
      throw new Error("micky output used a full claim as a decomposition label");
    }
    if (countSentences(entry.rationale) > 4) {
      throw new Error("micky output has overlong hypothesisDecomposition rationale");
    }
    if (containsNumericConfidenceScore(entry.rationale)) {
      throw new Error("micky output used a numeric confidence score in hypothesisDecomposition");
    }
    for (const cut of entry.whatWasCut) {
      if (!isConsideredAlternative(cut) || cut.type === "framework") {
        throw new Error("micky output has malformed decomposition cut item");
      }
    }
  }
  if (!Array.isArray(output.judgmentCalls)) {
    throw new Error("micky output missing judgmentCalls");
  }
  if (!Array.isArray(output.pushback) || output.pushback.length < 1) {
    throw new Error("micky output missing pushback");
  }
  if (output.signOff?.monogram !== "MB" || !nonEmpty(output.signOff.date)) {
    throw new Error("micky output missing MB sign-off");
  }
  if (countNumericConfidenceMentions(output) > 3) {
    throw new Error("micky output overused numeric confidence scores");
  }
}

function isNullableReframe(value: unknown): value is MickyReframe | null {
  return value === null || isMickyReframe(value);
}

function isMickyReframe(value: unknown): value is MickyReframe {
  return (
    typeof value === "object" &&
    value !== null &&
    nonEmpty((value as MickyReframe).headline) &&
    nonEmpty((value as MickyReframe).reasoning)
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function containsInternalFrameworkLeak(value: string): boolean {
  const lower = value.toLowerCase();
  const hasBannedTerm = [
    "agent victor",
    "hypothesis-weighted confidence tree",
    "mode-conditional sub-hypotheses",
    "internal architecture",
    "uuid",
    "market-entry-tiered",
    "ge-9-box-with-make-buy-ally",
  ].some((term) => lower.includes(term));
  const uuidLike =
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(
      value,
    );
  const parentheticalSlug = /\([a-z0-9]+(?:-[a-z0-9]+){2,}\)/i.test(value);
  return hasBannedTerm || uuidLike || parentheticalSlug;
}

function looksLikeRestatedQuestion(value: string): boolean {
  return /^pre-decision diligence question\s*:/i.test(value.trim());
}

function countSentences(value: string): number {
  const matches = value
    .trim()
    .match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  return matches?.filter((sentence) => sentence.trim().length > 0).length ?? 0;
}

function countNumericConfidenceMentions(output: MickyOutput): number {
  const prose = [
    output.reframe?.headline,
    output.reframe?.reasoning,
    output.recommendation.oneLiner,
    output.recommendation.weakestLink,
    output.recommendation.whatWouldFlipIt,
    output.frameworkRationale.chosen,
    ...output.frameworkRationale.rejected.flatMap((item) => [
      item.name,
      item.whyCut,
    ]),
    ...output.hypothesisRanking.flatMap((entry) => [
      entry.hypothesisLabel,
      entry.rationale,
    ]),
    ...output.hypothesisDecomposition.flatMap((entry) => [
      entry.hypothesisLabel,
      entry.rationale,
      ...entry.whatWasCut.flatMap((item) => [item.name, item.whyCut]),
    ]),
    ...output.judgmentCalls.flatMap((entry) => [
      entry.area,
      entry.thinness,
      entry.whyIWentThere,
    ]),
    ...output.pushback.map((entry) => entry.challenge),
  ]
    .filter(Boolean)
    .join("\n");
  return (prose.match(/\bconfidence(?:\s+(?:score|scores|sits|is|of|at))?[^.\n]{0,40}\b0\.\d+\b|\b0\.\d+\b/gi) ?? [])
    .length;
}

function containsNumericConfidenceScore(value: string): boolean {
  return /(?:confidence|scores?|scored|sits)\b[^.\n]{0,50}\b0\.\d+\b|\b0\.\d+\b(?=\s*[:),])/i.test(
    value,
  );
}

export function isConsideredAlternative(
  value: unknown,
): value is ConsideredAlternative {
  return (
    typeof value === "object" &&
    value !== null &&
    isConsideredAlternativeType((value as ConsideredAlternative).type) &&
    typeof (value as ConsideredAlternative).name === "string" &&
    typeof (value as ConsideredAlternative).whyCut === "string"
  );
}

function isConsideredAlternativeType(value: unknown): value is ConsideredAlternative["type"] {
  return (
    value === "hypothesis" ||
    value === "method" ||
    value === "scope" ||
    value === "framework"
  );
}
