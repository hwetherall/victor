Good, focused scope. Let me work through architecture first, then the visual, then a concrete mockup.

## Architecture

Micky is a separate, on-demand pass that runs *after* the decision agent completes. He's not load-bearing — if he fails, the decision still renders. This is important because it means you can iterate on his prompt without re-running the pipeline, and you can run him 2-3 times and pick the best output as a cheap quality lever.

**What he reads.** The full tree (decision, hypotheses, sub-hypotheses, evidence, confidences). The case brief. The framework binding. And critically — and this is the architectural gap you'll need to close first — the **rejection logs from upstream agents.** Right now I don't think your system captures what the brief parser, framework binder, or tree builder *considered and rejected.* If Micky has to invent the alternatives, he's doing theater, not partner work. The fix is small but necessary: each upstream agent emits an extra field — `consideredAlternatives` — listing 2-4 paths it evaluated and why they were cut. This costs you maybe 50 extra tokens per agent and unlocks the entire deltas-matter narration. Without it, Micky will hallucinate plausible-sounding rejected frameworks and you'll never quite trust him.

**What he produces.** Two-call structure, not one:

1. **Reframe attempt** — a focused call whose entire job is to stand back from the brief and ask "is the question well-posed?" Explicit permission to return null. Sometimes the brief is well-posed and the honest answer is no reframe. A forced reframe is worse than no reframe — that's where AI sounds like a try-hard. Separate this from the memo because it's a different kind of cognition (lateral, not synthetic).
2. **Memo synthesizer** — takes the reframe (or null), the tree, the rejection logs, and writes the structured memo.

**Output schema.** Don't make the memo a blob of prose. Make it a structured object that can render as a top-level memo *and* decompose into per-node annotations:

```ts
type MickyOutput = {
  reframe: { headline: string; reasoning: string } | null;
  recommendation: { oneLiner: string; weakestLink: string; whatWouldFlipIt: string };
  frameworkRationale: { chosen: string; rejected: { name: string; whyCut: string }[] };
  hypothesisRanking: { id: string; rank: number; whyThisRank: string }[];
  hypothesisDecomposition: { hypId: string; whyThese: string; whatWasCut: string[] }[];
  judgmentCalls: { area: string; thinness: string; whyIWentThere: string }[];
  signOff: { date: string; monogram: "MB" };
};
```

The hierarchical fields (`hypothesisRanking`, `hypothesisDecomposition`) are keyed by node ID so the UI can render them as inline annotations when a user drills into that node. You get two surfaces from one Micky run.

## Visual

Two surfaces, sharing one data source:

**The Memo.** A drawer or dedicated page (not a modal — modals are too transient for the headline insight), styled to feel like a real partner's note rather than a webpage. Cream/paper background, serif body, generous whitespace, signature monogram at the bottom. Render order matters: the **reframe is the first thing on the page, in the largest type.** This is your McDonalds-isn't-a-burger-company moment and it deserves the real estate. Recommendation second. Framework rationale third. Then the hypothesis ranking with a small grayed-out "considered but cut" sub-section under each — that's where deltas live. Then the judgment-calls section (this is the credibility move; a memo with honest hedges in the right places is more trustworthy than a uniformly confident one). Sign-off last.

**Per-node annotations.** When the user drills into Hypothesis 3, a small italic callout appears: *"Micky's note: I ranked this third because the threshold here is the most easily falsifiable — if it fails, the others don't matter. I considered breaking it into four sub-hypotheses but cut the channel-mix one because we covered it under H4."* One to three sentences. Always with the MB monogram so it's visually consistent.

**The ghost tree.** A small visual primitive that doesn't exist anywhere else: alongside the chosen hypothesis tree, render a faded silhouette of the rejected branches. Literal visual deltas. Toggleable. It makes "what we considered but cut" tangible in a way no prose can. This is the moment in the demo where Daniel goes *oh.*

## Fighting AI tells in the prompt

The biggest risk: Micky sounds like every other LLM and the persona collapses. A few prompt-level moves that help:

- **Forbid specific tells** by name in the system prompt (delve, tapestry, robust, comprehensive, multifaceted). Real partners never use these words.
- **Encourage fragments and short sentences.** "Two things stand out. One: market is real. Two: timing isn't." Not "There are two key considerations to highlight..."
- **Demand specificity over hedging.** "Confidence on H2 is thin because the parity-cost data is from 2022" beats "there is some uncertainty around competitive positioning."
- **Allow opinion.** Real partners disagree with the analysis sometimes. Give Micky permission to say "the tree says pursue but I'd want one more diligence cycle before I'd sign this."
- **Few-shot with one real partner memo example.** Even a synthetic one you write by hand. The format priors from a single good example are worth more than a page of instructions.

Let me show you what the memo could look like.A few things to notice about the mockup that aren't accidental:

The **reframe is the only thing in serif** and the only thing above 16px. Everything else in the memo is restrained. That asymmetry is the whole point — the reframe is the moment, and the rest of the memo is structured support for it. If you make every section visually loud, you've lost the hierarchy that makes the reframe land.

The **"considered but cut" sections** appear three times: under the framework choice, under the hypothesis ranking, and implicitly inside each judgment-call line ("if the integration slips, this falls"). Each one is visually quieter than the chosen path — gray text, italic label, left-border instead of full styling. This is the "deltas matter, but they live in the margin" principle made visual. The eye hits the choice first, the rejection second.

The **judgment-calls section** is doing a lot of work for credibility. Notice it's not a hedge — it doesn't say "we're not certain." It says specifically *what's thin* and *what evidence would make it not thin.* That's a partner move; vague hedging is a junior move. Your prompt for Micky should explicitly require this shape: name the thinness, name what would resolve it.

The **sign-off** is the smallest detail and the highest leverage on persona. A real partner memo has a name, a title, a date, and not much else. The MB monogram in a circle is the same primitive you'd reuse for the per-node "Micky's note" annotations — that consistency is what makes the persona feel like one entity rather than a series of LLM calls.

One thing I deliberately left out of the mockup but that I'd build into v1: a small "How I'd push back on this memo" section at the very bottom, written by Micky himself, listing the two or three things a skeptical reader should challenge. Partners do this in real memos because it pre-empts the reader's objections and signals that you've already considered them. It's the opposite of defensive — it's offensively honest. If you want to dial up "this AI sounds like it actually thinks," that section is where you do it.

For build order, I'd sequence it: rejection logging upstream first (small, unblocks everything), then the reframe call (standalone, separately testable), then the memo synthesizer (consumes both), then the per-node annotation rendering (reuses the memo's structured output, no new agent needed), then the ghost-tree as a polish item if there's time.