const BATCH_SIZE = 100;

function cosineSimilarity(a: number[], b: number[]) {
  let dot = 0; let normA = 0; let normB = 0;
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator ? dot / denominator : 0;
}

export type EmbeddingMap = Map<string, number[]>;

export function embeddingSimilarity(embeddings: EmbeddingMap, left: string, right: string) {
  const a = embeddings.get(left);
  const b = embeddings.get(right);
  if (!a || !b) return 0;
  return cosineSimilarity(a, b);
}

export async function embedPages(urls: string[], texts: string[]): Promise<EmbeddingMap> {
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error("JINA_API_KEY is not configured");
  if (urls.length !== texts.length) throw new Error("URLs and texts length mismatch");

  const vectors: number[][] = [];
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE).map((text) => ({ text: text.slice(0, 4000) }));
    const response = await fetch("https://api.jina.ai/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "jina-embeddings-v3",
        task: "text-matching",
        input: batch,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Jina Embeddings failed ${response.status}: ${text}`);
    }
    const data = await response.json() as { data?: { embedding: number[] }[] };
    if (!data.data || data.data.length !== batch.length) throw new Error("Réponse Jina embeddings invalide");
    vectors.push(...data.data.map((item) => item.embedding));
  }

  const map = new Map<string, number[]>();
  for (let index = 0; index < urls.length; index += 1) {
    map.set(urls[index], vectors[index]);
  }
  return map;
}
