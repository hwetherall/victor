"use client";

// STORY-025: render an Investigator (or Researcher) reasoning trace as a
// vertical timeline. Steps recorded mechanically by createInvestigatorSession
// (STORY-007) — phases like "tool_use:bash", "custom_tool_result:*",
// "outcome_eval:satisfied" — get visually grouped here so the auditability
// story is legible without raw JSON.
//
// Per the spec the OBSERVE / ORIENT / DECIDE / ACT / SELF-CRITIQUE narrative
// labels are also surfaced when an agent emits them inline in agent.message
// text. STORY-007 records them as phase="message" with the original text.
// This view groups by category and shows phase + content + timestamp.

import { useMemo, useState } from "react";
import type {
  AgentType,
  OutcomeGrade,
  ReasoningStep,
  ReasoningTrace,
  RejectedAlternative,
} from "@/lib/schema";

interface OODATimelineProps {
  trace: ReasoningTrace;
}

/** Visual category for a step. Keeps the timeline scannable. */
type Category =
  | "narration"
  | "thinking"
  | "tool"
  | "tool-result"
  | "outcome"
  | "delegation";

function categorize(phase: string): Category {
  if (phase === "message") return "narration";
  if (phase === "thinking") return "thinking";
  if (phase.startsWith("outcome_eval")) return "outcome";
  if (phase.startsWith("custom_tool_result") || phase === "tool_result") return "tool-result";
  if (phase.startsWith("tool_use") || phase.startsWith("tool_confirmation")) return "tool";
  // STORY-017: multi-agent thread + delegation events. Group everything
  // sub-agent-flavoured under "delegation" so the timeline visually
  // separates "the Investigator did X" from "the Investigator delegated to
  // the Researcher and got Y back".
  if (
    phase.startsWith("thread_") ||
    phase.startsWith("delegate_") ||
    phase.startsWith("stopped_because")
  ) {
    return "delegation";
  }
  return "tool";
}

const CATEGORY_STYLE: Record<Category, { label: string; cls: string }> = {
  narration: { label: "MESSAGE", cls: "border-emerald-700/60 text-emerald-300" },
  thinking: { label: "THINKING", cls: "border-violet-700/60 text-violet-300" },
  tool: { label: "TOOL USE", cls: "border-cyan-700/60 text-cyan-300" },
  "tool-result": { label: "RESULT", cls: "border-cyan-700/40 text-cyan-200/70" },
  outcome: { label: "OUTCOME", cls: "border-amber-700/60 text-amber-300" },
  delegation: { label: "DELEGATE", cls: "border-violet-700/60 text-violet-300" },
};

export function OODATimeline({ trace }: OODATimelineProps) {
  const steps = (trace.steps ?? []) as ReasoningStep[];
  const rejected = (trace.rejected_alternatives ?? []) as RejectedAlternative[];
  const grades = (trace.outcomes_grades ?? []) as OutcomeGrade[] | null;

  // Sort by timestamp asc (defensive — spec finding N1 noted ordering isn't
  // guaranteed at write time).
  const ordered = useMemo(
    () =>
      [...steps].sort((a, b) =>
        (a.timestamp ?? "").localeCompare(b.timestamp ?? ""),
      ),
    [steps],
  );

  return (
    <div className="flex flex-col gap-4">
      <Header trace={trace} stepCount={ordered.length} />

      {rejected.length > 0 && <RejectedSection rejected={rejected} />}

      {ordered.length === 0 ? (
        <p className="text-sm text-neutral-500">No reasoning steps recorded.</p>
      ) : (
        <ol className="flex flex-col gap-3 border-l border-neutral-800 pl-4">
          {ordered.map((step, i) => (
            <li key={i}>
              <Step step={step} />
            </li>
          ))}
        </ol>
      )}

      {grades && grades.length > 0 && <GradesSection grades={grades} />}
    </div>
  );
}

function Header({
  trace,
  stepCount,
}: {
  trace: ReasoningTrace;
  stepCount: number;
}) {
  const agentLabel: Record<AgentType, { label: string; cls: string }> = {
    investigator: { label: "Investigator", cls: "bg-emerald-500/15 text-emerald-300" },
    researcher: { label: "Researcher", cls: "bg-violet-500/15 text-violet-300" },
    micky: { label: "Micky", cls: "bg-amber-500/15 text-amber-300" },
  };
  const meta = agentLabel[trace.agent_type as AgentType] ?? agentLabel.investigator;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className={`rounded-full px-2 py-0.5 font-medium ${meta.cls}`}>
        {meta.label}
      </span>
      <span className="font-mono text-neutral-500">{stepCount} steps</span>
      {trace.managed_agent_session_id && (
        <a
          href={`https://console.anthropic.com/managed-agents/sessions/${trace.managed_agent_session_id}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-neutral-500 hover:text-neutral-300"
          title="Open Anthropic Console"
        >
          {trace.managed_agent_session_id}
        </a>
      )}
    </div>
  );
}

function Step({ step }: { step: ReasoningStep }) {
  // Special-cased Researcher synthesised steps (STORY-017 / STORY-019-R).
  // These carry JSON in `content`; render structured rather than as raw text.
  if (step.phase === "researcher_citations") {
    return <CitationsStep step={step} />;
  }
  if (step.phase === "researcher_search_path") {
    return <SearchPathStep step={step} />;
  }

  const cat = categorize(step.phase);
  const style = CATEGORY_STYLE[cat];
  return (
    <div
      className={`relative -ml-[1.05rem] flex flex-col gap-1 border-l-2 pl-3 text-xs ${style.cls}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${style.cls}`}
        >
          {style.label}
        </span>
        <span className="font-mono text-[10px] text-neutral-500">{step.phase}</span>
        {step.skill_used && (
          <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] text-emerald-300">
            skill: {step.skill_used}
          </span>
        )}
        {step.timestamp && (
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            {formatTime(step.timestamp)}
          </span>
        )}
      </div>
      <Body content={step.content} category={cat} />
    </div>
  );
}

interface Citation {
  url: string;
  title: string;
  quote: string;
}

function CitationsStep({ step }: { step: ReasoningStep }) {
  const citations = useMemo<Citation[]>(() => {
    try {
      const parsed = JSON.parse(step.content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [step.content]);
  return (
    <div className="-ml-[1.05rem] flex flex-col gap-1.5 border-l-2 border-violet-700/60 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-violet-700/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-violet-300">
          CITATIONS
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {citations.length} source{citations.length === 1 ? "" : "s"}
        </span>
        {step.timestamp && (
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            {formatTime(step.timestamp)}
          </span>
        )}
      </div>
      {citations.length === 0 ? (
        <p className="ml-3 italic text-neutral-500">(no citations parsed)</p>
      ) : (
        <ul className="ml-3 space-y-2">
          {citations.map((c, i) => (
            <li key={i} className="flex flex-col gap-0.5">
              <a
                href={c.url}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-violet-300 hover:text-violet-200"
                title={c.url}
              >
                [{i + 1}] {c.title || c.url}
              </a>
              {c.quote && (
                <p className="italic text-neutral-400">&ldquo;{c.quote}&rdquo;</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface SearchHop {
  query: string;
  resultCount: number;
  usefulCount: number;
}

function SearchPathStep({ step }: { step: ReasoningStep }) {
  const hops = useMemo<SearchHop[]>(() => {
    try {
      const parsed = JSON.parse(step.content);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [step.content]);
  return (
    <div className="-ml-[1.05rem] flex flex-col gap-1.5 border-l-2 border-violet-700/60 pl-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-violet-700/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-violet-300">
          SEARCH PATH
        </span>
        <span className="font-mono text-[10px] text-neutral-500">
          {hops.length} {hops.length === 1 ? "query" : "queries"}
        </span>
        {step.timestamp && (
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            {formatTime(step.timestamp)}
          </span>
        )}
      </div>
      {hops.length === 0 ? (
        <p className="ml-3 italic text-neutral-500">(no search path parsed)</p>
      ) : (
        <ol className="ml-3 space-y-1 text-neutral-300">
          {hops.map((h, i) => (
            <li key={i} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-[10px] text-neutral-500">
                {i + 1}.
              </span>
              <span className="font-mono">&ldquo;{h.query}&rdquo;</span>
              <span className="font-mono text-[10px] text-neutral-500">
                → {h.resultCount} results, {h.usefulCount} useful
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Body({ content, category }: { content: string; category: Category }) {
  const [expanded, setExpanded] = useState(false);
  const truncated = content.length > 240 && !expanded;
  const display = truncated ? content.slice(0, 240) + "…" : content;
  const isCode = category === "tool" || category === "tool-result";
  return (
    <div className="ml-3 flex flex-col gap-1">
      <div
        className={`whitespace-pre-wrap text-neutral-300 ${isCode ? "font-mono text-[11px]" : ""}`}
      >
        {display || <span className="italic text-neutral-500">(empty)</span>}
      </div>
      {content.length > 240 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="self-start text-[10px] text-neutral-500 hover:text-neutral-300"
        >
          {expanded ? "show less" : `show all (${content.length} chars)`}
        </button>
      )}
    </div>
  );
}

function RejectedSection({ rejected }: { rejected: RejectedAlternative[] }) {
  return (
    <details className="rounded border border-neutral-800 bg-neutral-950">
      <summary className="cursor-pointer px-3 py-2 text-xs text-neutral-300">
        Rejected methods ({rejected.length})
      </summary>
      <ul className="space-y-2 px-3 pb-3 pt-1 text-xs text-neutral-400">
        {rejected.map((r, i) => (
          <li key={i}>
            <span className="font-medium text-neutral-200">{r.candidate}</span>
            {r.reason && <span className="text-neutral-500"> — {r.reason}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}

function GradesSection({ grades }: { grades: OutcomeGrade[] }) {
  return (
    <div className="rounded border border-amber-700/40 bg-amber-950/20 p-3 text-xs">
      <p className="mb-2 font-medium text-amber-300">Outcomes evaluations</p>
      <ul className="space-y-1.5 text-amber-200/80">
        {grades.map((g, i) => (
          <li key={i}>
            attempt {g.iteration + 1} →{" "}
            <span className="font-mono">{g.result}</span>
            {g.explanation && (
              <span className="text-amber-200/60"> · {g.explanation}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatTime(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return ts;
  }
}
