import { isIP } from "node:net";

const blockedHosts = new Set(["localhost", "metadata.google.internal"]);

function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Only HTTP(S) URLs are supported");
  const host = url.hostname.toLowerCase();
  const privateIp = isIP(host) && /^(127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i.test(host);
  if (blockedHosts.has(host) || host.endsWith(".local") || privateIp) throw new Error("Private URLs are not supported");
  return url;
}

export async function readWithJina(value: string, timeout = 45_000) {
  const url = assertPublicUrl(value);
  const apiKey = process.env.JINA_API_KEY;
  if (!apiKey) throw new Error("JINA_API_KEY is not configured");

  const response = await fetch(`https://r.jina.ai/${url.toString()}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/plain",
    },
    signal: AbortSignal.timeout(timeout),
  });

  if (!response.ok) throw new Error(`Jina Reader failed with status ${response.status}`);
  return response.text();
}
