// Smoke for extractModelJson. Locks in the failure pattern from run
// 5093bfdc — model emitted a first JSON block, then "wait, let me correct"
// commentary, then a corrected JSON block. The old single-fence regex gave
// up on the whole string. The new extractor walks all blocks last-first.
//
// Run: tsx scripts/smoke-json-extract.ts

import { extractModelJson } from "@/lib/llm-client";

interface Case {
  name: string;
  input: string;
  expect: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "plain JSON object",
    input: '{"confidence": 0.7, "rationale": "ok"}',
    expect: { confidence: 0.7, rationale: "ok" },
  },
  {
    name: "single ```json fence",
    input: '```json\n{"confidence": 0.7}\n```',
    expect: { confidence: 0.7 },
  },
  {
    name: "single ``` fence (no language tag)",
    input: '```\n{"confidence": 0.7}\n```',
    expect: { confidence: 0.7 },
  },
  {
    name: "self-correction (two fenced blocks, take the last)",
    input: [
      "```json",
      '{"confidence": 0.82, "evidenceStrength": 8, "rationale": "first try", "evidenceStrength": 8}',
      "```",
      "",
      "Wait, I need to return valid JSON with unique keys. Let me correct:",
      "",
      "```json",
      '{"confidence": 0.82, "evidenceStrength": 8, "rationale": "corrected"}',
      "```",
    ].join("\n"),
    expect: {
      confidence: 0.82,
      evidenceStrength: 8,
      rationale: "corrected",
    },
  },
  {
    name: "JSON with leading commentary",
    input:
      'Here is my analysis:\n\n{"confidence": 0.5, "rationale": "x"}',
    expect: { confidence: 0.5, rationale: "x" },
  },
  {
    name: "JSON with trailing commentary",
    input: '{"confidence": 0.5}\n\nLet me know if you need more.',
    expect: { confidence: 0.5 },
  },
];

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main(): void {
  console.log("smoke: extractModelJson");
  let failed = 0;
  for (const c of CASES) {
    try {
      const got = extractModelJson(c.input);
      if (deepEqual(got, c.expect)) {
        console.log(`  ok: ${c.name}`);
      } else {
        console.error(
          `  FAIL: ${c.name}\n    expected ${JSON.stringify(c.expect)}\n    got      ${JSON.stringify(got)}`,
        );
        failed++;
      }
    } catch (e) {
      console.error(
        `  FAIL: ${c.name} (threw: ${e instanceof Error ? e.message : e})`,
      );
      failed++;
    }
  }
  if (failed > 0) {
    console.error(`smoke: ${failed} case(s) failed`);
    process.exit(1);
  }
  console.log("smoke: all cases passed");
}

main();
