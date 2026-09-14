import type { MappingRow } from "@/lib/ingest/mapping";

export type HubSpokeRec = {
  source: string;
  target: string;
  score: number;
  reasons: string[];
  type: string;
  priority: "HIGH" | "MEDIUM";
  direction: "incoming";
  anchorHint?: string;
};

export function buildHubSpokeRecommendations(
  mapping: MappingRow[],
  existing: Set<string>,
  validUrls: Set<string>
): HubSpokeRec[] {
  const byUrl = new Map<string, MappingRow>();
  const byCluster = new Map<string, MappingRow[]>();
  const byHubUrl = new Map<string, MappingRow[]>();

  for (const row of mapping) {
    byUrl.set(row.url, row);
    const cluster = row.cluster || row.hubUrl || "default";
    const c = byCluster.get(cluster) ?? [];
    c.push(row); byCluster.set(cluster, c);
    const hub = row.hubUrl || "default";
    const h = byHubUrl.get(hub) ?? [];
    h.push(row); byHubUrl.set(hub, h);
  }

  const add = (source: string, target: string, anchorHint: string, type: string, score: number, priority: "HIGH" | "MEDIUM", reason: string) => {
    if (!source || !target || source === target) return;
    if (!validUrls.has(source) || !validUrls.has(target)) return;
    if (existing.has(`${source}|${target}`)) return;
    recs.push({ source, target, score, reasons: [reason], type, priority, direction: "incoming", anchorHint: anchorHint || undefined });
  };

  const recs: HubSpokeRec[] = [];

  for (const row of mapping) {
    if (row.role === "HUB") {
      const spokes = byHubUrl.get(row.url) ?? byCluster.get(row.cluster) ?? [];
      for (const spoke of spokes) {
        if (spoke.url === row.url || spoke.role === "HUB") continue;
        add(row.url, spoke.url, spoke.keyword, "HUB → SPOKE", 90, "HIGH", `Hub ${row.cluster || ""} → spoke`);
      }
    } else {
      if (row.hubUrl) {
        const hub = byUrl.get(row.hubUrl);
        if (hub) add(row.url, hub.url, hub.keyword, "SPOKE → HUB", 85, "HIGH", `Spoke → hub ${hub.cluster || ""}`);
      }
      const siblings = byHubUrl.get(row.hubUrl) ?? byCluster.get(row.cluster) ?? [];
      for (const sibling of siblings) {
        if (sibling.url === row.url || sibling.role === "HUB") continue;
        if (sibling.hubUrl !== row.hubUrl) continue;
        add(row.url, sibling.url, sibling.keyword, "SPOKE → SPOKE", 70, "MEDIUM", `Spoke → spoke du même cluster ${row.cluster || ""}`);
      }
    }
  }

  return recs;
}
