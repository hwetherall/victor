// STORY-006: real custom-tool handlers for the Investigator Managed Agent.
// Replaces the placeholder handlers shipped in STORY-005. The handlers run
// inside the SSE stream consumer in lib/managed-agents-client.ts —
// `buildToolHandlers(input)` returns a per-session map that closes over the
// session's caseContext.
//
// Handler shape: takes the agent-supplied JSON input (validated minimally
// against the tool's input_schema), does the work, returns
// `{ text, is_error? }`. The text is stringified JSON sent back to the
// agent as a `user.custom_tool_result` event.
//
// Storage prerequisite: an InsForge bucket named "artifacts" must exist.
// Create it once via the InsForge dashboard. The SDK doesn't expose
// programmatic bucket creation as of @insforge/sdk 1.2.6.

import * as path from "node:path";
import { insforge } from "./db";
import { embedSingle } from "./embeddings";
import type { ArtifactType, InvestigatorInput, InvestigatorOutput } from "./schema";

export interface ToolResult {
  text: string;
  is_error?: boolean;
}

export type ToolHandler = (input: unknown) => Promise<ToolResult>;

const ARTIFACT_BUCKET = "artifacts";
const RETRIEVE_DEFAULT_TOP_K = 8;

// ─── retrieve_documents ──────────────────────────────────────────────────────
//
// Reuses the pgvector path from lib/retrieval.ts (similar_chunks RPC). The
// `document_ids` parameter from the tool input is currently advisory — the
// RPC filters by case_id, not source_id. If/when narrowing is needed we'll
// either extend the RPC or filter the result set client-side.

interface RetrieveDocsInput {
  query: string;
  document_ids?: string[];
  top_k?: number;
}

interface SimilarChunkRow {
  id: string;
  case_id: string;
  type: string;
  uri: string | null;
  title: string | null;
  content_extract: string | null;
  metadata: Record<string, unknown> | null;
  similarity: number;
}

async function handleRetrieveDocuments(
  input: InvestigatorInput,
  raw: unknown,
): Promise<ToolResult> {
  const args = (raw ?? {}) as RetrieveDocsInput;
  if (!args.query || typeof args.query !== "string") {
    return errorResult("retrieve_documents: missing required 'query' string");
  }

  const topK = clampInt(args.top_k, 1, 20, RETRIEVE_DEFAULT_TOP_K);
  const queryVec = await embedSingle(args.query);

  const { data, error } = await insforge.database.rpc("similar_chunks", {
    q_embedding: `[${queryVec.join(",")}]`,
    q_case_id: input.caseContext.caseId,
    q_top_k: topK,
  });
  if (error) {
    return errorResult(`retrieve_documents rpc: ${error.message}`);
  }

  const rows = (data as SimilarChunkRow[] | null) ?? [];
  // Note: the `document_ids` parameter is honoured at the query/phrasing
  // level only — the underlying RPC filters by case_id, not source_id, so
  // a strict client-side filter on r.id (chunk uuid) would always return
  // empty. Removed (guardian H3). If hard scoping is needed later, extend
  // similar_chunks RPC with a source_id IN (...) clause.

  // Trim to the canonical { source_id, quote, page_number } shape per
  // spec-v2.md §3.1 plus a similarity score so the agent can reason about
  // confidence in the match.
  const chunks = rows.map((r) => ({
    source_id: r.id,
    quote: (r.content_extract ?? "").slice(0, 4000),
    page_number: (r.metadata as { pageNumber?: number } | null)?.pageNumber ?? null,
    title: r.title,
    similarity: r.similarity,
  }));

  return {
    text: JSON.stringify({
      chunks,
      query: args.query,
      total_returned: chunks.length,
      note:
        chunks.length === 0
          ? "No matching chunks. Either the case has no ingested sources or the query is far from any chunk's embedding — try a different phrasing or rely on web_search/web_fetch."
          : undefined,
    }),
  };
}

// ─── upload_artifact ─────────────────────────────────────────────────────────
//
// Decodes the agent-supplied base64 blob, uploads to the InsForge `artifacts`
// bucket, and inserts an `artifacts` row tying it to the leaf and case.
// Versioning: if `parent_artifact_id` is provided, version = parent.version+1.

interface UploadArtifactInput {
  filename: string;
  content_b64: string;
  type: "xlsx" | "csv" | "png" | "md" | "json" | "model_lineage";
  change_reason?: string;
  parent_artifact_id?: string;
  metadata?: Record<string, unknown>;
}

const MIME_BY_TYPE: Record<UploadArtifactInput["type"], string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  png: "image/png",
  md: "text/markdown",
  json: "application/json",
  model_lineage: "application/json",
};

export async function handleUploadArtifact(
  input: InvestigatorInput,
  raw: unknown,
): Promise<ToolResult> {
  const args = (raw ?? {}) as UploadArtifactInput;
  if (!args.filename || !args.content_b64 || !args.type) {
    return errorResult(
      "upload_artifact: filename, content_b64, and type are all required",
    );
  }
  if (!(args.type in MIME_BY_TYPE)) {
    return errorResult(`upload_artifact: unknown type "${args.type}"`);
  }

  // Decode + sanitize filename.
  let buf: Buffer;
  try {
    buf = Buffer.from(args.content_b64, "base64");
  } catch (e) {
    return errorResult(
      `upload_artifact: invalid base64 (${e instanceof Error ? e.message : "unknown"})`,
    );
  }
  if (buf.length === 0) return errorResult("upload_artifact: empty content");
  if (buf.length > 25 * 1024 * 1024) {
    return errorResult(`upload_artifact: file too large (${buf.length} bytes; cap 25 MB)`);
  }

  const baseFilename = sanitizeFilename(path.basename(args.filename));
  const { caseId } = input.caseContext;
  const nodeId = input.hypothesis.id;

  // Compute version against parent.
  let version = 1;
  let parentVersion = 0;
  if (args.parent_artifact_id) {
    const { data, error } = await insforge.database
      .from("artifacts")
      .select("version")
      .eq("id", args.parent_artifact_id)
      .single();
    if (error || !data) {
      return errorResult(
        `upload_artifact: parent_artifact_id ${args.parent_artifact_id} not found`,
      );
    }
    parentVersion = (data as { version: number }).version;
    version = parentVersion + 1;
  }

  const storagePath = `${caseId}/${nodeId}/v${version}_${baseFilename}`;

  // Upload to InsForge storage. Blob is a global in Node 18+. Copy the Buffer
  // into a fresh Uint8Array — TS rejects passing a Node Buffer directly to
  // Blob() because Buffer.buffer can be SharedArrayBuffer in the ts lib types.
  const blob = new Blob([new Uint8Array(buf)], { type: MIME_BY_TYPE[args.type] });
  const upload = await insforge.storage.from(ARTIFACT_BUCKET).upload(storagePath, blob);
  if (upload.error) {
    return errorResult(
      `upload_artifact: storage upload failed (${upload.error.message ?? "unknown"}). ` +
        `Confirm the "${ARTIFACT_BUCKET}" bucket exists in InsForge.`,
    );
  }

  // Persist the row.
  const metadata = {
    ...(args.metadata ?? {}),
    ...(args.change_reason ? { change_reason: args.change_reason } : {}),
    bytes: buf.length,
    storage_bucket: ARTIFACT_BUCKET,
  };
  const { data: inserted, error: insErr } = await insforge.database
    .from("artifacts")
    .insert([
      {
        case_id: caseId,
        evidence_node_id: nodeId,
        type: args.type,
        uri: storagePath,
        version,
        parent_artifact_id: args.parent_artifact_id ?? null,
        metadata,
      },
    ])
    .select("id");
  if (insErr || !inserted?.[0]) {
    // Best-effort cleanup of the orphaned storage blob. If this fails too,
    // the original error is more useful than a chained one.
    try {
      await insforge.storage.from(ARTIFACT_BUCKET).remove(storagePath);
    } catch (cleanupErr) {
      console.warn(
        `[v2] upload_artifact orphaned blob cleanup failed for ${storagePath}: ` +
          `${cleanupErr instanceof Error ? cleanupErr.message : cleanupErr}`,
      );
    }
    return errorResult(
      `upload_artifact: row insert failed (${insErr?.message ?? "no row returned"}). ` +
        `Storage blob at ${storagePath} was removed.`,
    );
  }

  return {
    text: JSON.stringify({
      artifact_id: (inserted[0] as { id: string }).id,
      uri: storagePath,
      version,
      bytes: buf.length,
    }),
  };
}

// ─── rescueArtifactsFromTrace ───────────────────────────────────────────────
//
// STORY-020 wedge: server-side rescue for the Claude failure mode where the
// agent runs `base64 -w 0 /mnt/session/outputs/X.ext` via bash and then
// end_turns WITHOUT chaining into upload_artifact (observed on both Haiku 4.5
// and Sonnet 4.6 — the model treats the b64 in the bash tool_result as the
// deliverable). The stream consumer captures the full untruncated b64 string
// from the matching tool_result into `collectors.sandboxFileRescues`. This
// function decodes each rescue entry and uploads via handleUploadArtifact,
// returning the resulting artifact records for inclusion in InvestigatorOutput.
//
// Idempotent against handleUploadArtifact: if the agent actually DID call
// upload_artifact for a given file during the session, that filename appears
// in `alreadyUploaded` and the rescue skips it. Metadata flags rescued
// artifacts as `rescued_from_bash` so we can distinguish them in
// post-processing / drill-down UI later.

export async function rescueArtifactsFromTrace(
  input: InvestigatorInput,
  rescues: Array<{ path: string; type: ArtifactType; b64: string }>,
  alreadyUploaded: InvestigatorOutput["artifacts"],
): Promise<InvestigatorOutput["artifacts"]> {
  if (rescues.length === 0) return [];

  // Filenames from prior uploads land in the uri as `v{N}_filename.ext` —
  // strip the version prefix to compare against the bash-named file paths.
  const seenBasenames = new Set<string>();
  for (const a of alreadyUploaded) {
    const baseFromUri = a.uri.split("/").pop() ?? "";
    seenBasenames.add(baseFromUri.replace(/^v\d+_/, ""));
  }

  const out: InvestigatorOutput["artifacts"] = [];
  for (const r of rescues) {
    const basename = path.basename(r.path);
    if (seenBasenames.has(basename)) {
      console.log(
        `[v2] rescue skipped — ${basename} already uploaded by upload_artifact`,
      );
      continue;
    }
    const tr = await handleUploadArtifact(input, {
      filename: r.path,
      content_b64: r.b64,
      type: r.type,
      metadata: { rescued_from_bash: true, source_sandbox_path: r.path },
    });
    if (tr.is_error) {
      console.warn(`[v2] rescue failed for ${r.path}: ${tr.text}`);
      continue;
    }
    try {
      const parsed = JSON.parse(tr.text) as {
        artifact_id: string;
        uri: string;
        version: number;
      };
      out.push({
        artifactId: parsed.artifact_id,
        uri: parsed.uri,
        type: r.type,
        version: parsed.version,
      });
      seenBasenames.add(basename);
      console.log(
        `[v2] rescue uploaded ${basename} → artifact_id=${parsed.artifact_id} v${parsed.version}`,
      );
    } catch (e) {
      console.warn(
        `[v2] rescue uploaded ${r.path} but failed to parse response: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return out;
}

// ─── ask_user ────────────────────────────────────────────────────────────────
//
// Non-blocking HITL escalation. Inserts a user_questions row scoped to the
// case + leaf. Per spec-v2.md §3.1 + STORY-005 prompt: returns immediately;
// the agent does not wait for an answer.

interface AskUserInput {
  question: string;
  type: "yes_no" | "yes_no_context" | "open";
  options?: string[];
  needed_because?: string;
}

async function handleAskUser(
  input: InvestigatorInput,
  raw: unknown,
): Promise<ToolResult> {
  const args = (raw ?? {}) as AskUserInput;
  if (!args.question || !args.type) {
    return errorResult("ask_user: question and type are required");
  }
  if (!["yes_no", "yes_no_context", "open"].includes(args.type)) {
    return errorResult(`ask_user: invalid type "${args.type}"`);
  }

  const { caseId } = input.caseContext;
  const nodeId = input.hypothesis.id;
  // needed_because lives in metadata-style slots on the row. We don't have a
  // dedicated column; stash it inside `options` alongside any agent-supplied
  // option strings so the UI can surface both.
  const options = args.options ?? null;

  const { data, error } = await insforge.database
    .from("user_questions")
    .insert([
      {
        case_id: caseId,
        question: args.question,
        question_type: args.type,
        options,
        affects_node_ids: [nodeId],
        // created_by stays null at this stage — the agent itself is the
        // creator and we don't have a user-system mapping for that.
        // LEGAL-004 added the column for human users; agent-authored rows
        // sit cleanly with NULL.
      },
    ])
    .select("id");
  if (error || !data?.[0]) {
    return errorResult(`ask_user: insert failed (${error?.message ?? "no row"})`);
  }

  return {
    text: JSON.stringify({
      ok: true,
      question_id: (data[0] as { id: string }).id,
      note:
        "Question posted. Per spec-v2.md §3.1, ask_user is non-blocking — " +
        "continue your investigation with available evidence; the user's " +
        "answer arrives asynchronously.",
      needed_because: args.needed_because ?? null,
    }),
  };
}

// ─── read_sibling_leaf ───────────────────────────────────────────────────────
//
// Reads another leaf's finding within the same run. Whitelisted by
// `caseContext.siblingLeafIds` — the agent can't snoop on arbitrary nodes.

interface ReadSiblingInput {
  leaf_id: string;
}

async function handleReadSiblingLeaf(
  input: InvestigatorInput,
  raw: unknown,
): Promise<ToolResult> {
  const args = (raw ?? {}) as ReadSiblingInput;
  if (!args.leaf_id) return errorResult("read_sibling_leaf: leaf_id required");

  const allowed = input.caseContext.siblingLeafIds.includes(args.leaf_id);
  if (!allowed) {
    return errorResult(
      `read_sibling_leaf: ${args.leaf_id} is not in the sibling whitelist for this leaf`,
    );
  }

  const { data, error } = await insforge.database
    .from("tree_nodes")
    .select("id, label, type, status, confidence, content")
    .eq("id", args.leaf_id)
    .single();
  if (error || !data) {
    return errorResult(`read_sibling_leaf: ${args.leaf_id} not found`);
  }

  const row = data as {
    id: string;
    label: string;
    type: string;
    status: string;
    confidence: number | null;
    content: { finding?: string; claim?: string };
  };
  if (row.status !== "complete") {
    return {
      text: JSON.stringify({
        finding: null,
        confidence: null,
        status: row.status,
        note: `Sibling leaf ${row.id} is ${row.status}, not yet complete.`,
      }),
    };
  }
  return {
    text: JSON.stringify({
      finding: row.content.finding ?? row.content.claim ?? null,
      confidence: row.confidence,
      status: row.status,
      label: row.label,
    }),
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Build the per-session handler map. STORY-006: real bindings, async.
 * Each handler closes over the InvestigatorInput so it has caseId, nodeId,
 * documentIds, siblingLeafIds available without ambient context.
 */
export function buildToolHandlers(
  input: InvestigatorInput,
): Record<string, ToolHandler> {
  return {
    retrieve_documents: (raw) => handleRetrieveDocuments(input, raw),
    upload_artifact: (raw) => handleUploadArtifact(input, raw),
    ask_user: (raw) => handleAskUser(input, raw),
    read_sibling_leaf: (raw) => handleReadSiblingLeaf(input, raw),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errorResult(message: string): ToolResult {
  return { text: JSON.stringify({ error: message }), is_error: true };
}

function clampInt(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = typeof v === "number" ? Math.floor(v) : fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeFilename(name: string): string {
  // Keep alnum, dot, underscore, hyphen. Replace everything else with `_`.
  // Cap length at 200 chars to stay well under typical filesystem limits.
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return cleaned || "artifact";
}
