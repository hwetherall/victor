import { strict as assert } from "node:assert";
import type { Source } from "../lib/schema";

const BIAS_TOKENS = [
  "pre-disposed",
  "biased",
  "de-rated",
  "discounted",
  "conflict-of-interest",
];
const BIAS_NOTE =
  "Note: one or more sources was flagged as potentially predisposed; findings from those sources were weighted accordingly.";

function main() {
  const sources: Source[] = [
    {
      id: "source-1",
      case_id: "case-1",
      type: "pdf",
      uri: null,
      title: "ABB internal deck",
      content_extract: null,
      embedding: null,
      metadata: { author: "ABB" },
      created_at: new Date().toISOString(),
    },
  ];
  const input =
    "The ABB internal deck is pre-disposed-favourable; H4 evidence de-rated.";
  const output = stripBiasNearSources(input, sources);
  assert(output.includes(BIAS_NOTE));

  for (const token of BIAS_TOKENS) {
    const nearNamedSource = new RegExp(`ABB.{0,80}${token}|${token}.{0,80}ABB`, "i");
    assert(!nearNamedSource.test(output), `named source remained near ${token}`);
  }
}

function stripBiasNearSources(value: string, sources: Source[]): string {
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

try {
  main();
} catch (e) {
  console.error("smoke-export-bias-stripping failed:", e);
  process.exit(1);
}
