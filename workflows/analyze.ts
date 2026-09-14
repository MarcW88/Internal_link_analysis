import { saveRunState } from "@/lib/analysis/state";

type AnalyzeArgs = {
  inlinksUrl: string;
  crawlUrl: string;
  targetUrls?: string[];
  mappingUrl?: string;
  runId: string;
};

type Prepared = {
  status: "preparing";
  runId: string;
  recommendations: { source: string; target: string; score: number; reasons: string[]; type: string; priority: string; direction: "incoming" | "outgoing"; anchorHint?: string }[];
  pages: Record<string, { title: string; h1: string; meta: string }>;
  targetsByAnchor: Record<string, string[]>;
  summary: unknown;
  conflicts: unknown[];
  cannibalization: unknown[];
};

type Enriched = {
  recommendation?: { source: string; target: string; anchor: string; passage: string; score: number; direction: "incoming" | "outgoing"; conflict: boolean; type: string; priority: string };
  error?: string;
};

export async function analyzeWorkflow(args: AnalyzeArgs) {
  "use workflow";
  const { inlinksUrl, crawlUrl, targetUrls, mappingUrl, runId } = args;

  const prepared = await prepareStep({ inlinksUrl, crawlUrl, targetUrls, mappingUrl, runId });

  const recs = prepared.recommendations.slice(0, 8);
  const enriched = await Promise.all(
    recs.map((rec) => processSourceStep({ rec, pages: prepared.pages, targetsByAnchor: prepared.targetsByAnchor, runId })),
  );

  await finalizeStep({ runId, prepared, enriched });
}

async function prepareStep(args: AnalyzeArgs) {
  "use step";
  // TODO: brancher prepareCrawl pour générer les candidats sans Jina
  const stub: Prepared = {
    status: "preparing",
    runId: args.runId,
    recommendations: [],
    pages: {},
    targetsByAnchor: {},
    summary: { pages: 0 },
    conflicts: [],
    cannibalization: [],
  };
  await saveRunState<Prepared>(args.runId, stub);
  return stub;
}

async function processSourceStep({ rec, pages, targetsByAnchor, runId }: { rec: Prepared["recommendations"][0]; pages: Prepared["pages"]; targetsByAnchor: Prepared["targetsByAnchor"]; runId: string }) {
  "use step";
  // TODO: brancher enrichRecommendation avec Jina
  console.log("process source", rec.source, "for run", runId);
  return { recommendation: undefined, error: "stub" } as Enriched;
}

async function finalizeStep({ runId, prepared, enriched }: { runId: string; prepared: Prepared; enriched: Enriched[] }) {
  "use step";
  const recommendations = enriched.map((e) => e.recommendation).filter((r): r is NonNullable<typeof r> => Boolean(r));
  await saveRunState(runId, {
    status: "done",
    runId,
    summary: prepared.summary,
    conflicts: prepared.conflicts,
    cannibalization: prepared.cannibalization,
    recommendations,
  });
}
