import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { saveRunState } from "@/lib/analysis/state";
import { analyzeWorkflow } from "@/workflows/analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ error: "Origine refusée" }, { status: 403 });
    }

    const { inlinksUrl, crawlUrl, targetUrls, mappingUrl } = await request.json() as {
      inlinksUrl?: string;
      crawlUrl?: string;
      targetUrls?: string[];
      mappingUrl?: string;
    };

    if (!inlinksUrl || !crawlUrl) {
      return NextResponse.json({ error: "Les deux fichiers sont requis" }, { status: 400 });
    }

    const runId = crypto.randomUUID();
    await saveRunState(runId, { status: "pending", progress: 0, phase: "Démarrage" });

    await start(analyzeWorkflow, [{
      inlinksUrl,
      crawlUrl,
      targetUrls: targetUrls?.filter(Boolean),
      mappingUrl,
      runId,
    }]);

    return NextResponse.json({ runId, status: "started" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Analyse impossible" }, { status: 500 });
  }
}
