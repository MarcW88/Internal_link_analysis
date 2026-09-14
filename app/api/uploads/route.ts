import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin");
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Origine refusée" }, { status: 403 });

    const body = await request.json() as HandleUploadBody;
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.toLowerCase().endsWith(".csv")) throw new Error("Seuls les CSV sont acceptés");
        return { allowedContentTypes: ["text/csv", "application/vnd.ms-excel", "application/octet-stream"], maximumSizeInBytes: 100_000_000, addRandomSuffix: true };
      },
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(response);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Upload impossible" }, { status: 400 });
  }
}
