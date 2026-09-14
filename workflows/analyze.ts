import { get } from "@vercel/blob";
import { parseCsv } from "@/lib/ingest/csv";
import { parseMapping } from "@/lib/ingest/mapping";
import { buildResult, enrichRecommendation, prepareCrawl, type Prepared, type RawRec } from "@/lib/recommendations/workflow-engine";
import { saveRunState } from "@/lib/analysis/state";

type AnalyzeArgs = {
  inlinksUrl: string;
  crawlUrl: string;
  targetUrls?: string[];
  mappingUrl?: string;
  runId: string;
};

type Enriched = Awaited<ReturnType<typeof enrichRecommendation>>;

async function readPrivateCsv(url: string) {
  const blob = await get(url, { access: "private" });
  if (!blob) throw new Error("Fichier Blob introuvable");
  return parseCsv(await new Response(blob.stream).text());
}

export async function analyzeWorkflow(args: AnalyzeArgs) {
  "use workflow";
  const { inlinksUrl, crawlUrl, targetUrls, mappingUrl, runId } = args;

  const { rawCount } = await prepareStep({ inlinksUrl, crawlUrl, targetUrls, mappingUrl, runId });

  const enriched = await Promise.all(
    Array.from({ length: rawCount }, (_, index) => processSourceStep({ runId, index })),
  );

  await finalizeStep({ runId, enriched });
}

async function prepareStep(args: AnalyzeArgs) {
  "use step";
  const [inlinks, crawl, mapping] = await Promise.all([
    readPrivateCsv(args.inlinksUrl),
    readPrivateCsv(args.crawlUrl),
    args.mappingUrl ? readPrivateCsv(args.mappingUrl).then(parseMapping) : Promise.resolve([]),
  ]);

  const prepared = await prepareCrawl(inlinks, crawl, args.targetUrls?.filter(Boolean), mapping);
  await saveRunState(args.runId, { ...prepared, status: "preparing", phase: "Analyse du graphe et scoring" });

  return { runId: args.runId, rawCount: prepared.raw.length };
}

async function processSourceStep({ runId, index }: { runId: string; index: number }) {
  "use step";
  const prepared = await loadPrepared(runId);
  const rec = prepared.raw[index];
  if (!rec) throw new Error(`Recommandation ${index} introuvable`);
  return enrichRecommendation(rec, prepared.pages, prepared.targetsByAnchor, 45_000);
}

async function finalizeStep({ runId, enriched }: { runId: string; enriched: Enriched[] }) {
  "use step";
  const prepared = await loadPrepared(runId);
  const result = buildResult(prepared, enriched);
  await saveRunState(runId, { ...result, status: "done", phase: "Analyse terminée" });
}

async function loadPrepared(runId: string): Promise<Prepared> {
  const blob = await get(`workflow-runs/${runId}.json`, { access: "private" });
  if (!blob) throw new Error("État de l’analyse introuvable");
  return JSON.parse(await new Response(blob.stream).text()) as Prepared;
}
