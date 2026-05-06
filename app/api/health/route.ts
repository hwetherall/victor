import { NextResponse } from "next/server";
import { insforge } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await insforge.database
      .from("cases")
      .select("id")
      .limit(1);

    if (error) {
      return NextResponse.json(
        {
          ok: false,
          dbReachable: true,
          schemaApplied: false,
          error: error.message,
        },
        { status: 200 },
      );
    }

    return NextResponse.json({
      ok: true,
      dbReachable: true,
      schemaApplied: true,
      caseRows: data?.length ?? 0,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        dbReachable: false,
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
