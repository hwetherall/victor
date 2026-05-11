"use client";

// STORY-024 + 025 dev preview. Renders ArtifactViewer and OODATimeline
// against synthetic data so the components can be validated in the browser
// before the agent produces real artifacts on a live run.
//
// Open: http://localhost:3000/dev/v2-ui-preview
//
// Not meant for production — under app/dev/ so the path is self-documenting.

import { ArtifactViewer } from "@/components/ArtifactViewer";
import { OODATimeline } from "@/components/OODATimeline";
import type { Artifact, ReasoningTrace } from "@/lib/schema";

const fixtureArtifacts: Artifact[] = [
  {
    id: "fixture-sample",
    case_id: "00000000-0000-0000-0000-000000000000",
    evidence_node_id: null,
    type: "xlsx",
    uri: "fixtures/sample-financial-model.xlsx",
    version: 1,
    parent_artifact_id: null,
    metadata: {
      skill_name: "bottoms-up-financial-model",
      change_reason: "Initial draft with industry-average margin",
      bytes: 25043,
      storage_bucket: "fixtures",
    },
    created_at: new Date().toISOString(),
  },
];

const fixtureTrace: ReasoningTrace = {
  id: "fixture-trace",
  node_id: "fixture-node",
  agent_type: "investigator",
  managed_agent_session_id: "sesn_011CaoxJta9ycRy3JyqQnxcV",
  trace_id: "fixture",
  steps: [
    {
      phase: "tool_use:read",
      content: '{"file_path":"/workspace/skills/bottoms-up-financial-model/SKILL.md"}',
      timestamp: "2026-05-07T19:17:35Z",
    },
    {
      phase: "message",
      content:
        "OBSERVE: The falsifier requires comparing NPV at 15% to zero with a 3-year payback ceiling. Need: revenue ramp, capex, opex, WACC, terminal growth.",
      timestamp: "2026-05-07T19:17:50Z",
    },
    {
      phase: "tool_use:retrieve_documents",
      content: '{"query":"investment required capex revenue ramp IRR hurdle","top_k":8}',
      timestamp: "2026-05-07T19:18:02Z",
    },
    {
      phase: "custom_tool_result:retrieve_documents",
      content: '{"chunks":[{"source_id":"abc","quote":"…ABB segment margins of 28-32%…"}]}',
      timestamp: "2026-05-07T19:18:05Z",
    },
    {
      phase: "message",
      content:
        "ORIENT: Pick bottoms-up-financial-model. Rejected alternatives: comparable-transactions analog (insufficient public comps for intelligent PDU); top-down sizing (too coarse for IRR test).",
      timestamp: "2026-05-07T19:18:20Z",
      skill_used: "bottoms-up-financial-model",
    },
    {
      phase: "tool_use:bash",
      content: '{"command":"python build-model.py --inputs inputs.json --output model.xlsx"}',
      timestamp: "2026-05-07T19:18:35Z",
    },
    {
      phase: "tool_result",
      content: "Wrote /mnt/session/outputs/model.xlsx",
      timestamp: "2026-05-07T19:18:40Z",
    },
    {
      phase: "tool_use:upload_artifact",
      content: '{"filename":"model.xlsx","type":"xlsx","change_reason":"v1 with industry-average margin"}',
      timestamp: "2026-05-07T19:18:45Z",
    },
    {
      phase: "outcome_eval:satisfied",
      content: "All five rubric criteria met. Verdict: PASS on IRR (38%) but FAIL on payback (3.5yr). Confidence 0.6 capped by single-point estimate.",
      timestamp: "2026-05-07T19:19:30Z",
    },
  ],
  rejected_alternatives: [
    {
      candidate: "comparable-transactions analog",
      reason: "insufficient public comps in the intelligent-PDU segment",
    },
    {
      candidate: "top-down sizing",
      reason: "too coarse for an IRR test",
    },
  ],
  outcomes_grades: [
    {
      result: "needs_revision",
      iteration: 0,
      explanation: "Margin assumption used industry average; criterion 3 (lineage) needs ABB-specific source.",
    },
    {
      result: "satisfied",
      iteration: 1,
      explanation: "All 5 criteria met after retrieving ABB 10-K segment data.",
    },
  ],
  created_at: new Date().toISOString(),
};

export default function V2UiPreview() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 p-6">
      <header className="border-b border-neutral-800 pb-4">
        <h1 className="text-lg font-medium text-neutral-100">
          V2 UI preview
        </h1>
        <p className="mt-1 text-xs text-neutral-500">
          STORY-024 (artifact viewer) + STORY-025 (OODA timeline) against
          synthetic data. Real components, real fixture xlsx, no live API.
        </p>
      </header>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
          Artifact viewer
        </h2>
        <ArtifactViewer artifacts={fixtureArtifacts} />
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-neutral-500">
          OODA timeline
        </h2>
        <OODATimeline trace={fixtureTrace} />
      </section>
    </main>
  );
}
