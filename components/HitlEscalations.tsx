"use client";

// STORY-011: render HITL escalations the Investigator surfaced for this leaf.
// Cards show the question, the type (yes_no / yes_no_context / open), the
// available options if any, and an answer-or-pending state. Demo only —
// answering the question doesn't mutate state yet (would re-trigger the
// orchestrator; out of scope for the wedge demo).

import type { UserQuestion } from "@/lib/schema";

interface HitlEscalationsProps {
  escalations: UserQuestion[];
}

export function HitlEscalations({ escalations }: HitlEscalationsProps) {
  if (escalations.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {escalations.map((q) => (
        <Card key={q.id} q={q} />
      ))}
    </div>
  );
}

function Card({ q }: { q: UserQuestion }) {
  const answered = Boolean(q.answer);
  return (
    <div
      className={`rounded-lg border p-4 ${
        answered
          ? "border-neutral-800 bg-neutral-950"
          : "border-amber-700/40 bg-amber-950/20"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${
            answered
              ? "bg-neutral-800 text-neutral-400"
              : "bg-amber-500/20 text-amber-300"
          }`}
        >
          {answered ? "answered" : "open"}
        </span>
        <span className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
          {q.question_type}
        </span>
        {q.created_at && (
          <span className="ml-auto font-mono text-[10px] text-neutral-600">
            {new Date(q.created_at).toLocaleString(undefined, {
              dateStyle: "short",
              timeStyle: "short",
            })}
          </span>
        )}
      </div>

      <p className="text-sm text-neutral-100">{q.question}</p>

      {q.options && q.options.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2">
          {q.options.map((opt, i) => (
            <li key={i}>
              <span
                className={`rounded border px-2.5 py-1 text-xs ${
                  q.answer === opt
                    ? "border-emerald-700 bg-emerald-950/40 text-emerald-200"
                    : "border-neutral-700 text-neutral-300"
                }`}
              >
                {opt}
                {q.answer === opt && (
                  <span className="ml-1.5 text-[10px] uppercase tracking-wider text-emerald-400">
                    selected
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {answered && q.answer && !q.options?.includes(q.answer) && (
        <p className="mt-2 rounded border-l-2 border-emerald-700/50 bg-neutral-900/40 p-2 text-xs italic text-neutral-200">
          Answer: {q.answer}
        </p>
      )}
    </div>
  );
}
