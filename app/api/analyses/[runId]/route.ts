import { NextResponse } from "next/server";
import { getRunState } from "@/lib/analysis/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const state = await getRunState<unknown>(runId);

  if (!state) {
    return NextResponse.json({ status: "not_found" }, { status: 404 });
  }

  return NextResponse.json(state);
}
