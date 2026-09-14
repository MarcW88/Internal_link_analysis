import type { CsvRow } from "@/lib/ingest/csv";
import { extractContentBlocks, type ContentBlock } from "@/lib/content/blocks";
import { readWithJina } from "@/lib/content/jina";
import { selectExistingAnchor } from "@/lib/anchors/select";
import { pageRank } from "@/lib/graph/pagerank";
import { computeIdf, tfIdfCosine } from "@/lib/semantic/tfidf";
import { embedPages, embeddingSimilarity, type EmbeddingMap } from "@/lib/semantic/embeddings";
import { parseMapping, type MappingRow } from "@/lib/ingest/mapping";
import { buildHubSpokeRecommendations, type HubSpokeRec } from "@/lib/recommendations/hubspoke";

const aliases = {
  source: ["source", "from", "origine"],
  target: ["destination", "to", "target"],
  anchor: ["anchor", "anchor text", "link text", "texte d'ancre"],
  type: ["type"],
  position: ["position", "link position", "position du lien"],
  follow: ["follow", "suivre"],
  address: ["address", "adresse", "url"],
  title: ["title 1", "title", "titre"],
  h1: ["h1-1", "h1", "h1 1"],
  meta: ["meta description 1", "meta description"],
  status: ["status code", "code de statut", "status"],
  indexability: ["indexability", "indexabilité"],
  canonical: ["canonical link element 1", "canonical", "url canonique"],
  language: ["language", "langue"],
  depth: ["crawl depth", "profondeur de crawl"],
  wordCount: ["word count", "nombre de mots"],
};

type Page = {
  url: string;
  title: string;
  h1: string;
  meta: string;
  language: string;
  depth: number;
  wordCount: number;
  indexable: boolean;
  incoming: number;
  contentIncoming: number;
  navIncoming: number;
  footerIncoming: number;
  outgoingContent: number;
  pageType: PageType;
  seoScore: number;
  pageRank: number;
  priority: Priority;
};

type Link = {
  source: string;
  target: string;
  anchor: string;
  type: string;
  position: string;
  positionType: PositionType;
  anchorType: AnchorType;
};

type PositionType = "Content" | "Navigation" | "Footer" | "Other";
type AnchorType = "descriptive" | "generic" | "naked_url" | "image" | "navigation" | "empty";
type PageType = "HUB" | "BOOST" | "ORPHAN" | "WEAK" | "NORMAL";
type Priority = "HIGH" | "MEDIUM" | "OK";

function value(row: CsvRow, names: string[]) {
  const entry = Object.entries(row).find(([key]) => names.includes(key.trim().toLowerCase()));
  return entry?.[1]?.trim() ?? "";
}

function normalizeUrl(raw: string, base?: string) {
  try {
    const url = new URL(raw, base);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch { return ""; }
}

function domainOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; }
}

function normalizeText(raw: string) {
  return raw.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(raw: string, minLength = 3) {
  return new Set(normalizeText(raw).split(" ").filter((word) => word.length >= minLength));
}

function overlapScore(left: string, right: string) {
  const a = tokenSet(left); const b = tokenSet(right);
  if (!a.size || !b.size) return 0;
  const intersection = [...a].filter((word) => b.has(word)).length;
  return intersection / Math.sqrt(a.size * b.size);
}

function languageFromUrl(url: string) {
  try {
    const part = new URL(url).pathname.split("/").filter(Boolean)[0];
    return ["fr", "nl", "en", "de"].includes(part) ? part : "";
  } catch { return ""; }
}

function isLowValuePage(url: string) {
  const path = new URL(url).pathname.toLowerCase();
  const terms = ["privacy", "politique-cookies", "cookies", "cookie", "confidentialite", "datenschutz", "mentions-legales", "legal", "conditions", "terms", "sitemap", "wp-", "cdn-cgi"];
  return terms.some((term) => path.includes(term));
}

function classifyPosition(position: string): PositionType {
  const p = normalizeText(position);
  if (["contenu", "content", "body", "article", "main"].some((t) => p.includes(t))) return "Content";
  if (["navigation", "nav", "menu", "header", "tête", "head"].some((t) => p.includes(t))) return "Navigation";
  if (["pied de page", "footer", "bas de page"].some((t) => p.includes(t))) return "Footer";
  return "Other";
}

function classifyAnchor(anchor: string): AnchorType {
  if (!anchor) return "empty";
  const a = anchor.trim().toLowerCase();
  const generic = ["cliquez ici", "click here", "ici", "hier", "lire la suite", "en savoir plus", "plus", "voir", "lien", "link", "more", "read more", "découvrir", "ontdek", "learn more", "details", "détails", "suite", "continuer"];
  if (generic.includes(a)) return "generic";
  if (a.startsWith("http") || a.startsWith("www.") || a.includes("://")) return "naked_url";
  if (a.includes("<img") || a === "image") return "image";
  if (a.length <= 2) return "navigation";
  return "descriptive";
}

function isExcludedType(type: string) {
  const t = normalizeText(type);
  const terms = ["canonique", "canonical", "hreflang", "image", "sitemap", "divers", "css", "javascript", "js", "font", "police", "video", "audio", "iframe", "rel prev", "rel next", "redirection"];
  return terms.some((term) => t.includes(term));
}

function toNumber(raw: string) {
  const cleaned = raw.replace(",", ".").trim();
  const n = Number(cleaned);
  return Number.isNaN(n) ? 0 : n;
}

function classifiyPageType(page: Page, hasOutgoingContent: boolean): PageType {
  const indexable = page.indexable && !isLowValuePage(page.url);
  if (page.wordCount > 200 && hasOutgoingContent && indexable) return "HUB";
  if (page.wordCount >= 800 && indexable && !isLowValuePage(page.url)) return "HUB";
  if (page.wordCount > 150 && page.contentIncoming <= 5 && indexable) return "BOOST";
  if (indexable && page.incoming === 0 && page.wordCount > 30) return "ORPHAN";
  if (page.wordCount > 200 && page.contentIncoming <= 10 && page.incoming > 50 && indexable) return "BOOST";
  if (page.wordCount < 50 || !indexable) return "WEAK";
  return "NORMAL";
}

function seoPriority(page: Page): Priority {
  if (page.contentIncoming <= 2) return "HIGH";
  if (page.contentIncoming <= 5) return "MEDIUM";
  return "OK";
}

export async function analyzeCrawl(inlinkRows: CsvRow[], crawlRows: CsvRow[], targets?: string[], mappingRows?: MappingRow[]) {
  const crawl = new Map<string, Page>();
  for (const row of crawlRows) {
    const url = normalizeUrl(value(row, aliases.address));
    if (!url) continue;
    const status = Number(value(row, aliases.status) || 200);
    const indexability = normalizeText(value(row, aliases.indexability));
    const canonical = normalizeUrl(value(row, aliases.canonical), url);
    const lang = value(row, aliases.language).slice(0, 2).toLowerCase() || languageFromUrl(url);
    const page: Page = {
      url, title: value(row, aliases.title), h1: value(row, aliases.h1), meta: value(row, aliases.meta), language: lang,
      depth: toNumber(value(row, aliases.depth)), wordCount: toNumber(value(row, aliases.wordCount)),
      indexable: status === 200 && !indexability.includes("non indexable") && !indexability.includes("noindex") && (!canonical || canonical === url),
      incoming: 0, contentIncoming: 0, navIncoming: 0, footerIncoming: 0, outgoingContent: 0, pageType: "NORMAL", seoScore: 0, pageRank: 0, priority: "OK",
    };
    crawl.set(url, page);
  }

  const links: Link[] = inlinkRows.map((row) => {
    const source = normalizeUrl(value(row, aliases.source));
    const type = value(row, aliases.type);
    const position = value(row, aliases.position);
    return {
      source,
      target: normalizeUrl(value(row, aliases.target), source),
      anchor: value(row, aliases.anchor),
      type,
      position,
      positionType: classifyPosition(position),
      anchorType: classifyAnchor(value(row, aliases.anchor)),
    };
  }).filter((link) => link.source && link.target);

  const domains = links.map((l) => l.source).concat(links.map((l) => l.target)).map(domainOf).filter(Boolean);
  const targetDomain = domains.sort((a, b) => domains.filter((d) => d === b).length - domains.filter((d) => d === a).length)[0] ?? "";

  const kept = links.filter((link) => {
    if (isExcludedType(link.type)) return false;
    if (targetDomain && (domainOf(link.target) !== targetDomain || domainOf(link.source) !== targetDomain)) return false;
    return true;
  });

  const existing = new Set<string>();
  for (const link of kept.filter((l) => l.positionType === "Content")) existing.add(`${link.source}|${link.target}`);

  const incomingMap = new Map<string, number>();
  const contentIncomingMap = new Map<string, number>();
  const navIncomingMap = new Map<string, number>();
  const footerIncomingMap = new Map<string, number>();
  const outgoingContentMap = new Map<string, number>();
  const targetsByAnchor = new Map<string, Set<string>>();
  const anchorMap = new Map<string, { count: number; types: Record<string, number> }>();

  for (const link of kept) {
    link.anchorType = classifyAnchor(link.anchor);
    incomingMap.set(link.target, (incomingMap.get(link.target) ?? 0) + 1);
    if (link.positionType === "Content") contentIncomingMap.set(link.target, (contentIncomingMap.get(link.target) ?? 0) + 1);
    if (link.positionType === "Navigation") navIncomingMap.set(link.target, (navIncomingMap.get(link.target) ?? 0) + 1);
    if (link.positionType === "Footer") footerIncomingMap.set(link.target, (footerIncomingMap.get(link.target) ?? 0) + 1);
    if (link.positionType === "Content" && link.source) {
      outgoingContentMap.set(link.source, (outgoingContentMap.get(link.source) ?? 0) + 1);
      if (link.anchor) {
        const key = normalizeText(link.anchor);
        if (key) {
          const set = targetsByAnchor.get(key) ?? new Set<string>();
          set.add(link.target); targetsByAnchor.set(key, set);
        }
      }
    }
    const pageKey = link.target;
    const entry = anchorMap.get(pageKey) ?? { count: 0, types: {} };
    entry.count += 1;
    entry.types[link.anchorType] = (entry.types[link.anchorType] ?? 0) + 1;
    anchorMap.set(pageKey, entry);
  }

  const conflicts = [...targetsByAnchor.entries()].filter(([, targets]) => targets.size > 1).map(([anchor, targets]) => ({ anchor, targets: [...targets] }));

  const allUrls = new Set([...links.map((l) => l.target), ...crawl.keys()]);
  const pageAnalysis = new Map<string, Page>();
  const contentEdges = kept.filter((l) => l.positionType === "Content").map((l) => ({ source: l.source, target: l.target }));
  const pageRanks = pageRank(contentEdges);
  const maxRank = Math.max(...pageRanks.values(), 0) || 1;

  for (const url of allUrls) {
    const fromCrawl = crawl.get(url);
    const empty: Page = { url, title: "", h1: "", meta: "", language: "", depth: 0, wordCount: 0, indexable: true, incoming: 0, contentIncoming: 0, navIncoming: 0, footerIncoming: 0, outgoingContent: 0, pageType: "NORMAL", seoScore: 0, pageRank: 0, priority: "OK" };
    const page = fromCrawl ? { ...fromCrawl } : empty;
    page.url = url;
    page.incoming = incomingMap.get(url) ?? 0;
    page.contentIncoming = contentIncomingMap.get(url) ?? 0;
    page.navIncoming = navIncomingMap.get(url) ?? 0;
    page.footerIncoming = footerIncomingMap.get(url) ?? 0;
    page.outgoingContent = outgoingContentMap.get(url) ?? 0;
    page.pageRank = (pageRanks.get(url) ?? 0) / maxRank;
    page.pageType = classifiyPageType(page, page.outgoingContent >= 2);
    page.priority = seoPriority(page);
    pageAnalysis.set(url, page);
  }

  const totalLinks = kept.length;
  const contentLinks = kept.filter((l) => l.positionType === "Content").length;
  const navLinks = kept.filter((l) => l.positionType === "Navigation").length;
  const footerLinks = kept.filter((l) => l.positionType === "Footer").length;

  for (const page of pageAnalysis.values()) {
    const types = anchorMap.get(page.url)?.types ?? {};
    const descriptive = types.descriptive ?? 0;
    const total = page.incoming || 1;
    const contentScore = page.contentIncoming / Math.max(...[...pageAnalysis.values()].map((p) => p.contentIncoming), 1);
    const sourcesScore = new Set(kept.filter((l) => l.target === page.url && l.positionType === "Content").map((l) => l.source)).size / Math.max(...[...pageAnalysis.values()].map((p) => p.contentIncoming), 1);
    const sitewideRatio = page.incoming ? (page.navIncoming + page.footerIncoming) / page.incoming : 0;
    const anchorScore = descriptive / total;
    page.seoScore = Math.round(contentScore * 30 + sourcesScore * 30 + (1 - sitewideRatio) * 20 + anchorScore * 20);
  }

  const indexablePages = [...pageAnalysis.values()].filter((p) => p.indexable);
  const pageTexts = indexablePages.map((p) => `${p.title} ${p.h1} ${p.meta}`.trim() || p.url);
  const pageUrls = indexablePages.map((p) => p.url);
  const idf = computeIdf(pageTexts);

  let pageEmbeddings: EmbeddingMap = new Map();
  let embeddingError = "";
  if (targets?.length) {
    embeddingError = "Embeddings désactivés en mode URL cible pour accélérer l’analyse";
  } else {
    try {
      pageEmbeddings = await embedPages(pageUrls, pageTexts);
    } catch (error) {
      embeddingError = error instanceof Error ? error.message : "Embeddings non disponibles";
    }
  }

  const keywordCannibals: { keyword: string; urls: string[] }[] = [];
  if (mappingRows?.length) {
    const keywordMap = new Map<string, string[]>();
    for (const row of mappingRows) {
      const k = normalizeText(row.keyword);
      if (!k) continue;
      const list = keywordMap.get(k) ?? [];
      if (!list.includes(row.url)) list.push(row.url);
      keywordMap.set(k, list);
    }
    for (const [keyword, urls] of keywordMap) {
      if (urls.length > 1) keywordCannibals.push({ keyword, urls });
    }
  }

  const semanticCannibals: { urls: [string, string]; similarity: number; reason: string }[] = [];
  if (pageEmbeddings.size > 0) {
    const indexable = [...pageAnalysis.values()].filter((p) => p.indexable);
    for (let i = 0; i < indexable.length; i += 1) {
      const a = indexable[i];
      const aTokens = tokenSet(`${a.title} ${a.h1}`, 3);
      if (!aTokens.size) continue;
      for (let j = i + 1; j < Math.min(i + 40, indexable.length); j += 1) {
        const b = indexable[j];
        const bTokens = tokenSet(`${b.title} ${b.h1}`, 3);
        if (!bTokens.size) continue;
        const common = [...aTokens].filter((w) => bTokens.has(w)).length;
        const tokenOverlap = common / Math.sqrt(aTokens.size * bTokens.size);
        if (tokenOverlap < 0.25) continue;
        const sim = embeddingSimilarity(pageEmbeddings, a.url, b.url);
        if (sim > 0.82) {
          semanticCannibals.push({ urls: [a.url, b.url], similarity: sim, reason: "Titres/H1 très proches et similarité sémantique élevée" });
        }
      }
    }
  }

  function getThematicScore(sourceUrl: string, targetUrl: string) {
    const source = pageAnalysis.get(sourceUrl)!;
    const target = pageAnalysis.get(targetUrl)!;
    let score = 0;
    const reasons: string[] = [];

    const sourcePath = new URL(sourceUrl).pathname.toLowerCase().split("/").filter(Boolean);
    const targetPath = new URL(targetUrl).pathname.toLowerCase().split("/").filter(Boolean);
    if (sourcePath[0] && targetPath[0] && sourcePath[0] === targetPath[0]) {
      score += 30;
      reasons.push(`Même section /${sourcePath[0]}/`);
    }

    const sourceText = `${source.title} ${source.h1} ${source.meta}`.trim();
    const targetText = `${target.title} ${target.h1} ${target.meta}`.trim();
    if (sourceText && targetText) {
      const tfidf = tfIdfCosine(sourceText, targetText, idf);
      const embedding = pageEmbeddings.size ? embeddingSimilarity(pageEmbeddings, sourceUrl, targetUrl) : 0;
      const semantic = 0.6 * tfidf + 0.4 * embedding;
      score += semantic * 40;
      if (semantic > 0.3) {
        const s = tokenSet(sourceText, 3);
        const t = tokenSet(targetText, 3);
        const overlap = [...s].filter((w) => t.has(w));
        if (overlap.length) reasons.push(`Mots communs: ${overlap.slice(0, 3).join(", ")}`);
      }
    }

    if (source.wordCount > 500 && target.wordCount < 300) {
      score += 20;
      reasons.push(`Contenu riche (${source.wordCount}) → page à booster (${target.wordCount})`);
    } else if (source.wordCount > 300 && target.wordCount > 300 && Math.abs(source.wordCount - target.wordCount) < 200) {
      score += 15;
      reasons.push(`Contenus complémentaires (${source.wordCount} vs ${target.wordCount})`);
    }

    if (source.pageType === "HUB" && target.pageType === "BOOST") {
      score += 10;
      reasons.push("Hub → page à booster");
    }

    if (source.depth < target.depth && source.depth >= 1) {
      score += 10;
      reasons.push(`Équilibre profondeur (niv${source.depth} → niv${target.depth})`);
    }

    const rankDiff = source.pageRank - target.pageRank;
    if (rankDiff > 0) {
      score += rankDiff * 15;
      reasons.push(`Link equity (${Math.round(source.pageRank * 100)} → ${Math.round(target.pageRank * 100)})`);
    }

    return { score: Math.round(score), reasons };
  }

  type RawRec = { source: string; target: string; score: number; reasons: string[]; type: string; priority: Priority; direction: "incoming" | "outgoing"; anchorHint?: string };
  let rawRecommendations: RawRec[] = [];
  const targetUrls = targets?.map((url) => normalizeUrl(url)).filter((url) => pageAnalysis.has(url)).slice(0, 5) ?? [];

  const boostPages = [...pageAnalysis.values()].filter((p) => p.pageType === "BOOST").sort((a, b) => b.seoScore - a.seoScore);
  const hubPages = [...pageAnalysis.values()].filter((p) => p.pageType === "HUB");

  if (!targets?.length) {
    for (const target of boostPages.slice(0, 20)) {
      const existingSources = new Set(kept.filter((l) => l.target === target.url && l.positionType === "Content").map((l) => l.source));
      const candidates = hubPages
        .filter((source) => source.url !== target.url && !existingSources.has(source.url))
        .map((source) => ({ ...getThematicScore(source.url, target.url), source: source.url, target: target.url, type: "BOOST" as const, priority: "HIGH" as const, direction: "incoming" as const }))
        .filter((c) => c.score > 20)
        .sort((a, b) => b.score - a.score);
      if (candidates[0]) rawRecommendations.push(candidates[0]);
    }

    const orphanPages = [...pageAnalysis.values()].filter((p) => p.pageType === "ORPHAN").sort((a, b) => b.seoScore - a.seoScore);
    for (const target of orphanPages.slice(0, 15)) {
      const candidates = [...pageAnalysis.values()]
        .filter((source) => source.url !== target.url && ["HUB", "NORMAL", "BOOST"].includes(source.pageType))
        .map((source) => ({ ...getThematicScore(source.url, target.url), source: source.url, target: target.url, type: "ORPHAN" as const, priority: "HIGH" as const, direction: "incoming" as const }))
        .filter((c) => c.score > 15)
        .sort((a, b) => b.score - a.score);
      if (candidates[0]) rawRecommendations.push(candidates[0]);
    }

    for (const hub of hubPages.slice(0, 10)) {
      const outgoing = outgoingContentMap.get(hub.url) ?? 0;
      if (outgoing >= 3 || hub.wordCount <= 500) continue;
      const candidates = boostPages
        .filter((target) => target.url !== hub.url && !existing.has(`${hub.url}|${target.url}`))
        .map((target) => ({ ...getThematicScore(hub.url, target.url), source: hub.url, target: target.url, type: "HUB_OPTIMIZE" as const, priority: "MEDIUM" as const, direction: "incoming" as const }))
        .filter((c) => c.score > 20)
        .sort((a, b) => b.score - a.score);
      if (candidates[0]) rawRecommendations.push(candidates[0]);
    }
  } else {
    for (const targetUrl of targetUrls) {
      const target = pageAnalysis.get(targetUrl)!;
      const existingSources = new Set(kept.filter((l) => l.target === targetUrl && l.positionType === "Content").map((l) => l.source));
      const incoming = [...pageAnalysis.values()]
        .filter((source) => source.url !== targetUrl && !existingSources.has(source.url) && source.indexable && ["HUB", "NORMAL", "BOOST"].includes(source.pageType))
        .map((source) => ({ ...getThematicScore(source.url, targetUrl), source: source.url, target: targetUrl, type: "INCOMING" as const, priority: "HIGH" as const, direction: "incoming" as const }))
        .filter((c) => c.score > 20)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      rawRecommendations.push(...incoming);

      const existingTargets = new Set(kept.filter((l) => l.source === targetUrl && l.positionType === "Content").map((l) => l.target));
      const outgoing = [...pageAnalysis.values()]
        .filter((candidate) => candidate.url !== targetUrl && !existingTargets.has(candidate.url) && candidate.indexable && candidate.pageType !== "WEAK")
        .map((candidate) => ({ ...getThematicScore(targetUrl, candidate.url), source: targetUrl, target: candidate.url, type: "OUTGOING" as const, priority: "MEDIUM" as const, direction: "outgoing" as const }))
        .filter((c) => c.score > 20)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      rawRecommendations.push(...outgoing);
    }
  }

  if (mappingRows?.length) {
    const validUrls = new Set(pageAnalysis.keys());
    const hubSpoke = buildHubSpokeRecommendations(mappingRows, existing, validUrls);
    const filtered = targets?.length ? hubSpoke.filter((r) => targetUrls.includes(r.target)) : hubSpoke;
    rawRecommendations.push(...filtered);
  }

  rawRecommendations.sort((a, b) => {
    if (a.priority === "HIGH" && b.priority !== "HIGH") return -1;
    if (a.priority !== "HIGH" && b.priority === "HIGH") return 1;
    return b.score - a.score;
  });

  const recommendations = [] as Array<{ source: string; target: string; anchor: string; passage: string; score: number; direction: "incoming" | "outgoing"; conflict: boolean; type: string; priority: Priority }>;
  let scrapedPages = 0; let scrapeFailures = 0; let passagesWithoutAnchor = 0;
  const scrapeErrors = new Set<string>();
  const sourceBlocks = new Map<string, ContentBlock[]>();

  const topRecs = rawRecommendations.slice(0, targets?.length ? 12 : 10);
  const scrapeLimit = targets?.length ? 5 : 10;
  const uniqueSources = [...new Set(topRecs.map((r) => r.source))].slice(0, scrapeLimit);
  const jinaTimeout = targets?.length ? 12_000 : 45_000;
  await Promise.all(uniqueSources.map(async (source) => {
    try {
      sourceBlocks.set(source, extractContentBlocks(await readWithJina(source, jinaTimeout)));
      scrapedPages += 1;
    } catch (error) {
      scrapeFailures += 1;
      scrapeErrors.add(error instanceof Error ? error.message : "Scraping impossible");
      sourceBlocks.set(source, []);
    }
  }));

  for (const rec of topRecs) {
    const target = pageAnalysis.get(rec.target)!;
    const fallbackAnchor = rec.anchorHint || target.h1 || target.title;
    const blocks = sourceBlocks.get(rec.source);
    if (blocks?.length) {
      const selected = selectExistingAnchor(blocks, { title: target.title || target.h1, keyword: rec.anchorHint || target.h1 });
      if (selected) {
        const normalized = selected.anchor.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ");
        const targetsForAnchor = targetsByAnchor.get(normalized);
        const conflict = Boolean(targetsForAnchor && [...targetsForAnchor].some((url) => url !== rec.target));
        if (conflict) continue;
        const score = Math.round(rec.score * 0.55 + (selected.quality / 100) * 45);
        recommendations.push({ source: rec.source, target: rec.target, anchor: selected.anchor, passage: selected.passage, score, direction: rec.direction, conflict: false, type: rec.type, priority: rec.priority });
        continue;
      }
      passagesWithoutAnchor += 1;
    }

    if (fallbackAnchor) {
      recommendations.push({ source: rec.source, target: rec.target, anchor: fallbackAnchor, passage: rec.reasons.join(" | "), score: rec.score, direction: rec.direction, conflict: false, type: rec.type, priority: rec.priority });
    }
  }

  const excludedPages = [...pageAnalysis.values()].filter((p) => !p.indexable).length;
  const weakPages = [...pageAnalysis.values()].filter((p) => p.pageType === "WEAK").length;
  const hubCount = [...pageAnalysis.values()].filter((p) => p.pageType === "HUB").length;
  const boostCount = [...pageAnalysis.values()].filter((p) => p.pageType === "BOOST").length;
  const orphanCount = [...pageAnalysis.values()].filter((p) => p.pageType === "ORPHAN").length;

  const cannibalization = [
    ...conflicts.map((c) => ({ type: "anchor" as const, label: c.anchor, urls: c.targets, score: c.targets.length })),
    ...keywordCannibals.map((k) => ({ type: "keyword" as const, label: k.keyword, urls: k.urls, score: k.urls.length })),
    ...semanticCannibals.map((s) => ({ type: "semantic" as const, label: s.reason, urls: s.urls, score: Math.round(s.similarity * 100) })),
  ];

  return {
    summary: {
      pages: pageAnalysis.size,
      links: totalLinks,
      contextualLinks: contentLinks,
      excludedPages,
      weakPages,
      hubPages: hubCount,
      boostPages: boostCount,
      orphanPages: orphanCount,
      averagePageRank: Math.round([...pageAnalysis.values()].reduce((sum, p) => sum + p.pageRank, 0) / Math.max(pageAnalysis.size, 1) * 100),
      conflicts: conflicts.length,
      cannibalization: cannibalization.length,
      scrapedPages,
      scrapeFailures,
      passagesWithoutAnchor,
      recommendations: recommendations.length,
      averageSeoScore: Math.round([...pageAnalysis.values()].reduce((sum, p) => sum + p.seoScore, 0) / Math.max(pageAnalysis.size, 1)),
    },
    scrapeErrors: [...scrapeErrors],
    conflicts,
    cannibalization,
    recommendations: recommendations.sort((a, b) => b.score - a.score),
  };
}
