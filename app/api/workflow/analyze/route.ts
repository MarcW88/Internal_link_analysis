import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { analyzeWorkflow } from "@/workflows/analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  const { inlinksUrl, crawlUrl, targetUrls, mappingUrl } = await request.json() as {
    inlinksUrl?: string;
    crawlUrl?: string;
    targetUrls?: string[];
    mappingUrl?: string;
  };

  if (!inlinksUrl || !crawlUrl) {
    return NextResponse.json({ error: "Les deux CSV sont requis" }, { status: 400 });
  }

  const runId = crypto.randomUUID();

  await start(analyzeWorkflow, [{
    inlinksUrl,
    crawlUrl,
    targetUrls: targetUrls?.filter(Boolean),
    mappingUrl,
    runId,
  }]);

  return NextResponse.json({ runId, status: "started" });
}
