import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { start } from "workflow/api";
import { parseCsv } from "@/lib/ingest/csv";
import { parseMapping } from "@/lib/ingest/mapping";
import { createRun, setRunInputs } from "@/lib/analysis/state";
import { analyzeWorkflow } from "@/workflows/analyze";

export const runtime = "nodejs";
export const maxDuration = 60;

async function readPrivateCsv(url: string) {
  const blob = await get(url, { access: "private" });
  if (!blob) throw new Error("Fichier Blob introuvable");
  return parseCsv(await new Response(blob.stream).text());
}

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
    await createRun(runId, "pending", "Démarrage");

    const [inlinks, crawl, mapping] = await Promise.all([
      readPrivateCsv(inlinksUrl),
      readPrivateCsv(crawlUrl),
      mappingUrl ? readPrivateCsv(mappingUrl).then(parseMapping) : Promise.resolve([]),
    ]);

    await setRunInputs(runId, inlinks, crawl, mapping, targetUrls?.filter(Boolean));

    await start(analyzeWorkflow, [{
      runId,
    }]);

    return NextResponse.json({ runId, status: "started" });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Analyse impossible" }, { status: 500 });
  }
}
