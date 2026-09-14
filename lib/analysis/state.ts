import { del, get, put } from "@vercel/blob";

const prefix = "workflow-runs";

export async function saveRunState<T>(runId: string, data: T) {
  await put(`${prefix}/${runId}.json`, JSON.stringify(data), {
    access: "private",
    contentType: "application/json",
  });
}

export async function getRunState<T>(runId: string): Promise<T | null> {
  try {
    const blob = await get(`${prefix}/${runId}.json`, { access: "private" });
    if (!blob) return null;
    const text = await new Response(blob.stream).text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function deleteRunState(runId: string) {
  try {
    await del(`${prefix}/${runId}.json`);
  } catch {
    // ignore
  }
}
