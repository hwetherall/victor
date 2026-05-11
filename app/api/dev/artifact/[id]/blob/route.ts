// STORY-024: serve artifact bytes to the ArtifactViewer.
//
// Tries InsForge storage first; falls back to the local public/fixtures/
// sample if the artifact is unknown OR uri starts with "fixtures/" (so the
// dev path can preview the viewer without a real upload).

import { NextResponse } from "next/server";
import * as fs from "node:fs";
import * as path from "node:path";
import { insforge } from "@/lib/db";
import type { Artifact, ArtifactType } from "@/lib/schema";

export const dynamic = "force-dynamic";

const MIME_BY_TYPE: Record<ArtifactType, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  png: "image/png",
  md: "text/markdown",
  json: "application/json",
  model_lineage: "application/json",
};

const ARTIFACT_BUCKET = "artifacts";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Fixture passthrough for dev: id="fixture-sample" → public/fixtures/sample-financial-model.xlsx
  if (id === "fixture-sample") {
    return serveFixture("sample-financial-model.xlsx", "xlsx");
  }

  // Real artifact: look up the row, then download from InsForge.
  const { data, error } = await insforge.database
    .from("artifacts")
    .select("id, type, uri, metadata")
    .eq("id", id)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "artifact not found" },
      { status: 404 },
    );
  }
  const artifact = data as Pick<Artifact, "id" | "type" | "uri" | "metadata">;

  // Allow rows with `uri` of "fixtures/..." to bypass storage (used by the
  // demo seeder so we can preview real-shaped rows pointing at fixture files).
  if (artifact.uri.startsWith("fixtures/")) {
    const tail = artifact.uri.replace(/^fixtures\//, "");
    return serveFixture(tail, artifact.type);
  }

  const dl = await insforge.storage.from(ARTIFACT_BUCKET).download(artifact.uri);
  if (dl.error || !dl.data) {
    return NextResponse.json(
      {
        error: `storage download failed: ${dl.error?.message ?? "no data"}`,
        uri: artifact.uri,
      },
      { status: 502 },
    );
  }

  const buf = Buffer.from(await dl.data.arrayBuffer());
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": MIME_BY_TYPE[artifact.type] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}

function serveFixture(filename: string, type: ArtifactType): NextResponse {
  // Strip any path components — the caller-supplied tail must NOT escape
  // public/fixtures/. Without this a row with `uri = "fixtures/../../lib/db.ts"`
  // would resolve outside the fixtures dir (guardian H1).
  const safe = path.basename(filename);
  const abs = path.resolve("public/fixtures", safe);
  if (!fs.existsSync(abs)) {
    return NextResponse.json(
      { error: `fixture not found: ${safe}` },
      { status: 404 },
    );
  }
  const buf = fs.readFileSync(abs);
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": MIME_BY_TYPE[type] ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}
