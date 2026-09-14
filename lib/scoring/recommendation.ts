export type RecommendationSignals = {
  pageSemantic: number;
  paragraphContext: number;
  targetOpportunity: number;
  graphOpportunity: number;
  architecture: number;
  anchorQuality: number;
};

const weights: Record<keyof RecommendationSignals, number> = {
  pageSemantic: 0.3,
  paragraphContext: 0.25,
  targetOpportunity: 0.15,
  graphOpportunity: 0.15,
  architecture: 0.1,
  anchorQuality: 0.05,
};

export function recommendationScore(signals: RecommendationSignals) {
  return Math.round(
    Object.entries(weights).reduce(
      (score, [signal, weight]) => score + signals[signal as keyof RecommendationSignals] * weight,
      0,
    ),
  );
}
