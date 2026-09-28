export interface RankedCandidate {
  id: string;
  vectorRank: number | null;
  keywordRank: number | null;
}

/** Reciprocal rank fusion. k=60 is the standard constant; items in both lists rise. */
export function reciprocalRankFusion<T extends RankedCandidate>(candidates: T[], k = 60): (T & { fused: number })[] {
  return candidates
    .map((c) => ({
      ...c,
      fused: (c.vectorRank ? 1 / (k + c.vectorRank) : 0) + (c.keywordRank ? 1 / (k + c.keywordRank) : 0),
    }))
    .sort((a, b) => b.fused - a.fused);
}
