import { NextResponse } from "next/server";
import { selectExistingAnchor } from "@/lib/anchors/select";
import { extractContentBlocks } from "@/lib/content/blocks";
import { readWithJina } from "@/lib/content/jina";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const apiSecret = (process.env.ANALYSIS_API_TOKEN ?? process.env.ANALYSIS_API_SECRET)?.trim();
    if (!apiSecret || request.headers.get("authorization")?.trim() !== `Bearer ${apiSecret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json() as { sourceUrl?: string; targetTitle?: string; targetKeyword?: string };
    if (!body.sourceUrl || (!body.targetTitle && !body.targetKeyword)) {
      return NextResponse.json({ error: "sourceUrl and a target title or keyword are required" }, { status: 400 });
    }

    const markdown = await readWithJina(body.sourceUrl);
    const blocks = extractContentBlocks(markdown);
    const recommendation = selectExistingAnchor(blocks, { title: body.targetTitle, keyword: body.targetKeyword });

    return NextResponse.json({ sourceUrl: body.sourceUrl, blocks: blocks.length, recommendation });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Analysis failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
