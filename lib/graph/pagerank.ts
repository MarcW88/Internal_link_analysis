export type Edge = { source: string; target: string };

export function pageRank(edges: Edge[], damping = 0.85, iterations = 40) {
  const nodes = [...new Set(edges.flatMap(({ source, target }) => [source, target]))];
  if (!nodes.length) return new Map<string, number>();

  const outgoing = new Map(nodes.map((node) => [node, edges.filter((edge) => edge.source === node).map((edge) => edge.target)]));
  let ranks = new Map(nodes.map((node) => [node, 1 / nodes.length]));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map(nodes.map((node) => [node, (1 - damping) / nodes.length]));
    for (const source of nodes) {
      const targets = outgoing.get(source) ?? [];
      const share = (ranks.get(source) ?? 0) / (targets.length || nodes.length);
      for (const target of targets.length ? targets : nodes) next.set(target, (next.get(target) ?? 0) + damping * share);
    }
    ranks = next;
  }

  return ranks;
}
