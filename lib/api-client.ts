// Browser-side fetch helpers for the UI. All endpoints return JSON; non-2xx
// responses throw with the body's `error` field when available.

import type { EvidenceItem } from "@/app/api/runs/[id]/nodes/[nodeId]/evidence/route";
import type { MickyRun, Run, TreeNode } from "@/lib/schema";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // body wasn't JSON — fall back to status text
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok && res.status !== 202) {
    let message = `HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b?.error) message = b.error;
    } catch {
      /* noop */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function deleteJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { method: "DELETE", cache: "no-store" });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* noop */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ─── Endpoints ───────────────────────────────────────────────────────────────

export async function fetchLatestRun(caseConfigId: string): Promise<Run | null> {
  const res = await fetch(`/api/cases/${caseConfigId}/runs/latest`, {
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { run: Run | null };
  return body.run;
}

export interface RunDetailResponse {
  run: Run;
  decision?: TreeNode;
}

export function fetchRun(runId: string): Promise<RunDetailResponse> {
  return getJson<RunDetailResponse>(`/api/runs/${runId}`);
}

export interface NodesResponse {
  run: Run;
  nodes: TreeNode[];
  byType: {
    decision: TreeNode[];
    hypothesis: TreeNode[];
    sub_hypothesis: TreeNode[];
    evidence: TreeNode[];
    question: TreeNode[];
  };
}

export function fetchRunNodes(runId: string): Promise<NodesResponse> {
  return getJson<NodesResponse>(`/api/runs/${runId}/nodes`);
}

export interface NodeDetailResponse {
  node: TreeNode;
  children: TreeNode[];
}

export function fetchNodeDetail(
  runId: string,
  nodeId: string,
): Promise<NodeDetailResponse> {
  return getJson<NodeDetailResponse>(`/api/runs/${runId}/nodes/${nodeId}`);
}

export interface EvidenceResponse {
  parentNode: TreeNode;
  evidence: EvidenceItem[];
}

export function fetchNodeEvidence(
  runId: string,
  nodeId: string,
): Promise<EvidenceResponse> {
  return getJson<EvidenceResponse>(
    `/api/runs/${runId}/nodes/${nodeId}/evidence`,
  );
}

export interface StartRunResponse {
  runId: string;
  caseId: string;
}

export function startRunRequest(
  caseConfigId: string,
): Promise<StartRunResponse> {
  return postJson<StartRunResponse>("/api/runs", { caseId: caseConfigId });
}

export async function fetchMickyRuns(runId: string): Promise<MickyRun[]> {
  const body = await getJson<{ runs: MickyRun[] }>(`/api/runs/${runId}/micky`);
  return body.runs;
}

export interface TriggerMickyRunResponse {
  mickyRunId: string;
  attemptNumber: number;
}

export function triggerMickyRun(
  runId: string,
): Promise<TriggerMickyRunResponse> {
  return postJson<TriggerMickyRunResponse>(`/api/runs/${runId}/micky`, {});
}

export function deleteMickyRun(
  runId: string,
  attemptId: string,
): Promise<{ ok: true }> {
  return deleteJson<{ ok: true }>(
    `/api/runs/${runId}/micky?attemptId=${encodeURIComponent(attemptId)}`,
  );
}
