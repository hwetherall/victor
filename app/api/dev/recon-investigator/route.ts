// STORY-020 recon: dump Investigator reasoning_traces for given run_ids so
// we can see the agent's actual final agent.message + any sandbox writes
// it made before deciding what shape the engineering fix needs to take.
//
// Run:
//   curl -s "http://localhost:3000/api/dev/recon-investigator?run_ids=22268647-a371-4717-bca0-d88de9e1d3a3,17e4c6c8-5390-48ea-9b7d-80648f96f546"
//
// Returns per-run: trace rows (filtered to agent_type='investigator'), each
// row's last `phase: "message"` step (the final agent.message text), and any
// `phase: "tool_use:write"` / `phase: "tool_use:edit"` steps with their
// captured inputs (so we can see whether the Investigator writes a
// structured block to a sandbox file like the Researcher does).

import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";
import type { ReasoningTrace, ReasoningStep } from "@/lib/schema";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // Accept either session_ids (sesn_...) or fall back to "all recent
  // investigator traces" if none provided.
  const sessionIdsParam = url.searchParams.get("session_ids");
  const sessionIds = sessionIdsParam
    ? sessionIdsParam.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const out: Array<{
    filter: string;
    trace_count: number;
    traces: Array<{
      node_id: string;
      managed_agent_session_id: string | null;
      agent_type: string;
      step_count: number;
      message_count: number;
      write_count: number;
      edit_count: number;
      last_message_text: string | null;
      first_chars_of_last_message: string | null;
      last_message_starts_with_confidence: boolean;
      sandbox_writes: Array<{
        phase: string;
        path: string;
        contains_confidence: boolean;
        contains_evidence_summary: boolean;
        contains_rejected_alternatives: boolean;
        content_first_400: string;
        content_length: number;
      }>;
    }>;
  }> = [];

  if (sessionIds) {
    for (const sessionId of sessionIds) {
      const res = await insforge.database
        .from("reasoning_traces")
        .select("*")
        .eq("managed_agent_session_id", sessionId)
        .eq("agent_type", "investigator")
        .order("created_at", { ascending: true });
      if (res.error) {
        return NextResponse.json(
          { error: `reasoning_traces[${sessionId}]: ${res.error.message}` },
          { status: 500 },
        );
      }
      const rows = (res.data as ReasoningTrace[] | null) ?? [];
      out.push({
        filter: `session=${sessionId}`,
        trace_count: rows.length,
        traces: rows.map((row) => analyzeTrace(row)),
      });
    }
  } else {
    // Fallback: most-recent N investigator traces.
    const res = await insforge.database
      .from("reasoning_traces")
      .select("*")
      .eq("agent_type", "investigator")
      .order("created_at", { ascending: false })
      .limit(5);
    if (res.error) {
      return NextResponse.json(
        { error: `reasoning_traces: ${res.error.message}` },
        { status: 500 },
      );
    }
    const rows = (res.data as ReasoningTrace[] | null) ?? [];
    out.push({
      filter: "recent_5",
      trace_count: rows.length,
      traces: rows.map((row) => analyzeTrace(row)),
    });
  }

  return NextResponse.json({ ok: true, runs: out });
}

function analyzeTrace(row: ReasoningTrace) {
  const steps = (row.steps ?? []) as ReasoningStep[];
  const messageSteps = steps.filter((s) => s.phase === "message");
  const writeSteps = steps.filter(
    (s) => s.phase === "tool_use:write" || s.phase === "tool_use:edit",
  );
  const lastMessage = messageSteps[messageSteps.length - 1];
  const lastMessageText = lastMessage?.content ?? null;
  const firstChars = lastMessageText
    ? lastMessageText
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0) ?? null
    : null;

  const sandboxWrites = writeSteps
    .map((s) => {
      let parsedInput: Record<string, unknown> | null = null;
      try {
        parsedInput = JSON.parse(s.content) as Record<string, unknown>;
      } catch {
        parsedInput = null;
      }
      const path =
        (typeof parsedInput?.path === "string" && parsedInput.path) ||
        (typeof parsedInput?.file_path === "string" && parsedInput.file_path) ||
        "";
      const content =
        (typeof parsedInput?.content === "string" && parsedInput.content) ||
        (typeof parsedInput?.new_string === "string" &&
          parsedInput.new_string) ||
        "";
      return {
        phase: s.phase,
        path,
        contains_confidence: /\bCONFIDENCE:\s*[0-9.]/.test(content),
        contains_evidence_summary: /\bEVIDENCE_SUMMARY:/.test(content),
        contains_rejected_alternatives: /\bREJECTED_ALTERNATIVES:/.test(content),
        content_first_400: content.slice(0, 400),
        content_length: content.length,
      };
    })
    .filter((w) => w.path); // drop entries we couldn't parse path from

  return {
    node_id: row.node_id,
    managed_agent_session_id: row.managed_agent_session_id,
    agent_type: row.agent_type,
    step_count: steps.length,
    message_count: messageSteps.length,
    write_count: writeSteps.filter((s) => s.phase === "tool_use:write").length,
    edit_count: writeSteps.filter((s) => s.phase === "tool_use:edit").length,
    last_message_text: lastMessageText
      ? lastMessageText.slice(0, 1500)
      : null,
    first_chars_of_last_message: firstChars,
    last_message_starts_with_confidence:
      !!firstChars && /^CONFIDENCE:\s*[0-9.]/.test(firstChars),
    sandbox_writes: sandboxWrites,
  };
}
