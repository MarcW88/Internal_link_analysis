import type { CsvRow } from "@/lib/ingest/csv";

export type MappingRow = {
  url: string;
  keyword: string;
  keyword2: string;
  role: "HUB" | "SPOKE";
  hubUrl: string;
  cluster: string;
};

function normalizeUrl(raw: string) {
  try {
    const url = new URL(raw);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch { return ""; }
}

function toText(raw: string) {
  return (raw ?? "").trim();
}

export function parseMapping(rows: CsvRow[]): MappingRow[] {
  const columnMap: Record<string, string> = {};
  if (!rows.length) return [];
  for (const column of Object.keys(rows[0])) {
    const key = column.toLowerCase().trim();
    if (["url", "adresse", "address", "page", "page url", "lien", "link"].includes(key)) {
      columnMap["URL"] = column;
    } else if (["keyword", "mot-clé", "mot cle", "primary keyword", "mot-clé principal", "kw", "cible", "target keyword", "ancre recommandée", "ancre"].includes(key)) {
      columnMap["Keyword"] = column;
    } else if (["secondary keyword", "mot-clé secondaire", "secondary", "kw2", "ancre 2"].includes(key)) {
      columnMap["Keyword2"] = column;
    } else if (["role", "rôle", "type", "page type", "page role", "niveau", "level", "hub", "catégorie", "category", "cluster"].includes(key)) {
      columnMap["Role"] = column;
    } else if (["hub_url", "hub url", "parent", "parent url", "pillar url", "hub", "pilier", "parent page"].includes(key)) {
      columnMap["Hub_URL"] = column;
    } else if (["cluster", "groupe", "group", "thématique", "thematique", "topic"].includes(key)) {
      columnMap["Cluster"] = column;
    }
  }

  const headers = Object.keys(rows[0]);
  const urlCol = columnMap["URL"] ?? headers[0];
  const keywordCol = columnMap["Keyword"] ?? (headers[1] ?? "");

  const mapped: MappingRow[] = [];
  for (const row of rows) {
    const url = normalizeUrl(toText(row[urlCol]));
    if (!url) continue;
    const keyword = toText(row[keywordCol] ?? "");
    const keyword2 = toText(row[columnMap["Keyword2"] ?? ""] ?? "");
    const hubUrl = normalizeUrl(toText(row[columnMap["Hub_URL"] ?? ""] ?? ""));
    const cluster = toText(row[columnMap["Cluster"] ?? ""] ?? "");
    const rawRole = toText(row[columnMap["Role"] ?? ""] ?? "").toUpperCase();
    const role = /HUB|PILIER|PILLAR|CLUSTER|CATEGOR/.test(rawRole) ? "HUB" : "SPOKE";
    mapped.push({ url, keyword, keyword2, role, hubUrl, cluster });
  }
  return mapped;
}
