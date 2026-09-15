function normalize(raw: string) {
  return raw.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenize(raw: string) {
  return normalize(raw).split(" ").filter((word) => word.length >= 3);
}

export function computeIdf(documents: string[]) {
  const documentFrequency = new Map<string, number>();
  const total = documents.length || 1;
  for (const document of documents) {
    const seen = new Set<string>();
    for (const term of tokenize(document)) {
      if (seen.has(term)) continue;
      seen.add(term);
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [term, frequency] of documentFrequency.entries()) {
    idf.set(term, Math.log(1 + total / frequency));
  }
  return idf;
}

function computeTfVector(text: string) {
  const vector = new Map<string, number>();
  const tokens = tokenize(text);
  if (!tokens.length) return vector;
  for (const term of tokens) {
    vector.set(term, (vector.get(term) ?? 0) + 1);
  }
  for (const [term, count] of vector.entries()) {
    vector.set(term, count / tokens.length);
  }
  return vector;
}

export function tfIdfVector(text: string, idf: Map<string, number>) {
  const vector = new Map<string, number>();
  for (const [term, tf] of computeTfVector(text).entries()) {
    vector.set(term, tf * (idf.get(term) ?? 0));
  }
  return vector;
}

function dotProduct(a: Map<string, number>, b: Map<string, number>) {
  let sum = 0;
  for (const [term, value] of a.entries()) {
    if (b.has(term)) sum += value * (b.get(term) ?? 0);
  }
  return sum;
}

function magnitude(vector: Map<string, number>) {
  return Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0));
}

export function tfIdfCosine(left: string, right: string, idf: Map<string, number>) {
  const a = tfIdfVector(left, idf);
  const b = tfIdfVector(right, idf);
  return cosineBetween(a, b);
}

export function cosineBetween(a: Map<string, number>, b: Map<string, number>) {
  const denominator = magnitude(a) * magnitude(b);
  return denominator ? dotProduct(a, b) / denominator : 0;
}
