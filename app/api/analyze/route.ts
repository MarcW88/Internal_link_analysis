import { del, get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { parseCsv } from "@/lib/ingest/csv";
import { parseMapping } from "@/lib/ingest/mapping";
import { analyzeCrawl } from "@/lib/recommendations/engine";

export const runtime = "nodejs";
export const maxDuration = 300;

async function readPrivateCsv(url: string) {
  const blob = await get(url, { access: "private" });
  if (!blob) throw new Error("Fichier Blob introuvable");
  return parseCsv(await new Response(blob.stream).text());
}

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });

    const { inlinksUrl, crawlUrl, targetUrls, mappingUrl } = await request.json() as { inlinksUrl?: string; crawlUrl?: string; targetUrls?: string[]; mappingUrl?: string };
    if (!inlinksUrl || !crawlUrl) return NextResponse.json({ error: "Les deux fichiers sont requis" }, { status: 400 });

    const [inlinks, crawl, mapping] = await Promise.all([
      readPrivateCsv(inlinksUrl),
      readPrivateCsv(crawlUrl),
      mappingUrl ? readPrivateCsv(mappingUrl).then(parseMapping) : Promise.resolve([]),
    ]);
    const result = await analyzeCrawl(inlinks, crawl, targetUrls, mapping);
    await del([inlinksUrl, crawlUrl, ...(mappingUrl ? [mappingUrl] : [])]);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Analyse impossible" }, { status: 500 });
  }
}
