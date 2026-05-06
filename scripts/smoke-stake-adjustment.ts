// Smoke check for EPIC-V3-03 (improve.md §5): one-step asymmetric stake
// adjustment in agents/evidence/score.ts. Locks the rule confirmed
// 2026-05-06: demote supportive findings from biased sources, promote
// surprising findings from biased sources, no adjustment for neutral-advocate
// or third-party.
//
// Run: tsx scripts/smoke-stake-adjustment.ts

import { applyStakeAdjustment, type ScoredItem } from "@/agents/evidence/score";
import type {
  EvidenceStrength,
  EvidenceSupports,
  SourceStake,
} from "@/lib/schema";

interface Case {
  name: string;
  in: { supports: EvidenceSupports; strength: EvidenceStrength };
  stake: SourceStake | undefined;
  out: { supports: EvidenceSupports; strength: EvidenceStrength };
  rawStrength?: EvidenceStrength;
}

const CASES: Case[] = [
  // ── Pre-disposed favourable (e.g. ABB deck) ───────────────────────────────
  {
    name: "deck supports yes (strong/for) → demoted to moderate/for",
    in: { supports: "for", strength: "strong" },
    stake: "pre-disposed-favourable",
    out: { supports: "for", strength: "moderate" },
    rawStrength: "strong",
  },
  {
    name: "deck supports yes (moderate/for) → demoted to weak/for",
    in: { supports: "for", strength: "moderate" },
    stake: "pre-disposed-favourable",
    out: { supports: "for", strength: "weak" },
    rawStrength: "moderate",
  },
  {
    name: "deck supports yes (weak/for) → stays weak/for (already floor)",
    in: { supports: "for", strength: "weak" },
    stake: "pre-disposed-favourable",
    out: { supports: "for", strength: "weak" },
  },
  {
    name: "deck concedes a problem (moderate/against) → promoted to strong",
    in: { supports: "against", strength: "moderate" },
    stake: "pre-disposed-favourable",
    out: { supports: "against", strength: "strong" },
    rawStrength: "moderate",
  },
  {
    name: "deck concedes a problem (weak/against) → promoted to moderate",
    in: { supports: "against", strength: "weak" },
    stake: "pre-disposed-favourable",
    out: { supports: "against", strength: "moderate" },
    rawStrength: "weak",
  },
  {
    name: "deck mixed evidence is unaffected",
    in: { supports: "mixed", strength: "moderate" },
    stake: "pre-disposed-favourable",
    out: { supports: "mixed", strength: "moderate" },
  },

  // ── Pre-disposed against (mirror) ─────────────────────────────────────────
  {
    name: "skeptic supports no (strong/against) → demoted to moderate/against",
    in: { supports: "against", strength: "strong" },
    stake: "pre-disposed-against",
    out: { supports: "against", strength: "moderate" },
    rawStrength: "strong",
  },
  {
    name: "skeptic concedes yes (moderate/for) → promoted to strong/for",
    in: { supports: "for", strength: "moderate" },
    stake: "pre-disposed-against",
    out: { supports: "for", strength: "strong" },
    rawStrength: "moderate",
  },

  // ── Neutral-advocate (no adjustment) ──────────────────────────────────────
  {
    name: "Innovera brief support (strong/for) → unchanged (neutral-advocate)",
    in: { supports: "for", strength: "strong" },
    stake: "neutral-advocate",
    out: { supports: "for", strength: "strong" },
  },
  {
    name: "Innovera brief contradicts (moderate/against) → unchanged",
    in: { supports: "against", strength: "moderate" },
    stake: "neutral-advocate",
    out: { supports: "against", strength: "moderate" },
  },

  // ── Third-party (no adjustment) ───────────────────────────────────────────
  {
    name: "web/third-party (strong/for) → unchanged",
    in: { supports: "for", strength: "strong" },
    stake: "third-party",
    out: { supports: "for", strength: "strong" },
  },

  // ── Undefined stake (no adjustment) ───────────────────────────────────────
  {
    name: "undefined stake → unchanged",
    in: { supports: "for", strength: "strong" },
    stake: undefined,
    out: { supports: "for", strength: "strong" },
  },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

function main(): void {
  console.log("smoke: stake adjustment rule");
  for (const c of CASES) {
    const item: ScoredItem = {
      finding: "test finding",
      supports: c.in.supports,
      strength: c.in.strength,
    };
    const got = applyStakeAdjustment(item, c.stake);
    assert(
      got.supports === c.out.supports,
      `${c.name} — supports correct (${got.supports})`,
    );
    assert(
      got.strength === c.out.strength,
      `${c.name} — strength correct (${got.strength})`,
    );
    if (c.rawStrength) {
      assert(
        got.rawStrength === c.rawStrength,
        `${c.name} — rawStrength preserved (${got.rawStrength})`,
      );
    } else {
      assert(
        got.rawStrength === undefined,
        `${c.name} — no rawStrength when unchanged`,
      );
    }
  }
  console.log("smoke: all cases passed");
}

main();
