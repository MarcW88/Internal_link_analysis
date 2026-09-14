import type { ContentBlock } from "@/lib/content/blocks";

const stopWords = new Set(["avec", "dans", "pour", "sans", "sous", "chez", "cette", "votre", "vous", "nous", "leur", "leurs", "des", "les", "une", "the", "and", "for", "with", "from"]);

function normalize(value: string) {
  return value.toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
}

function terms(value: string) {
  return new Set(normalize(value).split(" ").filter((word) => word.length > 2 && !stopWords.has(word)));
}

export function selectExistingAnchor(blocks: ContentBlock[], target: { title?: string; keyword?: string }) {
  const targetTerms = terms(`${target.title ?? ""} ${target.keyword ?? ""}`);
  if (!targetTerms.size) return null;

  const ranked = blocks.flatMap((block) => {
    const words = block.content.match(/[\p{L}\p{N}’-]+/gu) ?? [];
    const candidates = [] as { anchor: string; score: number }[];
    for (let size = 2; size <= 7; size += 1) {
      for (let index = 0; index <= words.length - size; index += 1) {
        const anchor = words.slice(index, index + size).join(" ");
        const anchorTerms = terms(anchor);
        const matches = [...anchorTerms].filter((term) => targetTerms.has(term)).length;
        if (!matches) continue;
        const precision = matches / anchorTerms.size;
        const coverage = matches / targetTerms.size;
        candidates.push({ anchor, score: precision * 0.55 + coverage * 0.45 });
      }
    }
    const best = candidates.sort((a, b) => b.score - a.score || a.anchor.length - b.anchor.length)[0];
    return best ? [{ ...best, block }] : [];
  }).sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best || best.score < 0.35) return null;
  return { anchor: best.anchor, passage: best.block.content, heading: best.block.heading, position: best.block.position, quality: Math.round(best.score * 100), action: "ADD_LINK_ONLY" as const };
}
