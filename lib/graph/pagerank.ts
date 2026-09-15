export type Edge = { source: string; target: string };

export function pageRank(edges: Edge[], damping = 0.85, iterations = 40) {
  const nodes = [...new Set<string>(edges.flatMap(({ source, target }) => [source, target]))];
  if (!nodes.length) return new Map<string, number>();

  const outgoing = new Map<string, string[]>();
  for (const { source, target } of edges) {
    const list = outgoing.get(source);
    if (list) list.push(target);
    else outgoing.set(source, [target]);
  }

  const n = nodes.length;
  const initialRank = 1 / n;
  let ranks = new Map<string, number>(nodes.map((node) => [node, initialRank]));
  const defaultShare = (1 - damping) / n;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map<string, number>(nodes.map((node) => [node, defaultShare]));
    for (const source of nodes) {
      const targets = outgoing.get(source);
      const share = (ranks.get(source) ?? 0) / (targets?.length || n);
      if (targets && targets.length) {
        for (const target of targets) next.set(target, (next.get(target) ?? 0) + damping * share);
      } else {
        for (const target of nodes) next.set(target, (next.get(target) ?? 0) + damping * share);
      }
    }
    ranks = next;
  }

  return ranks;
}
