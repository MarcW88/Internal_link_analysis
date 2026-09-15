import { buildResult, enrichRecommendation, prepareCrawl, type Enriched, type Prepared } from "@/lib/recommendations/workflow-engine";
import {
  addRunEnrichment,
  getRunEnrichments,
  getRunInputs,
  getRunPrepared,
  setRunPrepared,
  setRunResult,
} from "@/lib/analysis/state";

export async function analyzeWorkflow(args: { runId: string }) {
  "use workflow";
  const { runId } = args;

  const { rawCount } = await prepareStep({ runId });

  const enriched = await Promise.all(
    Array.from({ length: rawCount }, (_, index) => processSourceStep({ runId, index })),
  );

  await finalizeStep({ runId, enriched });
}

async function prepareStep(args: { runId: string }) {
  "use step";
  const inputs = await getRunInputs(args.runId);
  if (!inputs) throw new Error("Données d’analyse introuvables");

  const prepared = await prepareCrawl(inputs.inlinks, inputs.crawl, inputs.targets, inputs.mapping || undefined);
  await setRunPrepared(args.runId, prepared);

  return { runId: args.runId, rawCount: prepared.raw.length };
}

async function processSourceStep({ runId, index }: { runId: string; index: number }) {
  "use step";
  const prepared = await getRunPrepared<Prepared>(runId);
  if (!prepared) throw new Error("État préparé introuvable");
  const rec = prepared.raw[index];
  if (!rec) throw new Error(`Recommandation ${index} introuvable`);
  const enriched = await enrichRecommendation(rec, prepared.pages, prepared.targetsByAnchor, 45_000);
  await addRunEnrichment(runId, index, enriched);
  return enriched;
}

async function finalizeStep({ runId, enriched }: { runId: string; enriched: Enriched[] }) {
  "use step";
  const prepared = await getRunPrepared<Prepared>(runId);
  if (!prepared) throw new Error("État préparé introuvable");
  const result = buildResult(prepared, enriched);
  await setRunResult(runId, result);
}
