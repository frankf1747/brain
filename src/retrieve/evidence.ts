import { config } from "../config.js";
import { isDegraded, type Degraded, type Evidence } from "./contract.js";
import { triggerTerms } from "./fallback.js";

/** Strips the punctuation triggerTerms strips around a token. */
const stripToken = (raw: string) => raw.replace(/^[?,!;:()"“”'‘’]+|[?,!;:().'"“”‘’]+$/g, "");

/**
 * A query that is nothing but trigger terms (codes, figures, quoted strings): "X-90", "$115k", "REQ-4471". For these a
 * relevance score says little, while a literal match says a lot.
 */
export function isBareLiteralLookup(query: string): boolean {
  const terms = new Set(triggerTerms(query));
  if (terms.size === 0) return false;
  const rest = query.replace(/["“][^"”]+["”]/g, " ");
  return rest.split(/\s+/).map(stripToken).every((t) => !/[\p{L}\p{N}]/u.test(t) || terms.has(t));
}

/**
 * Whether the passages are likely to hold an answer (Phase 7; the rule and the threshold were fixed on the calibration
 * split before the held-out items were searched, see docs/superpowers/plans/2026-10-04-phase-7-abstention.md):
 *  - strong (literal): the query is a bare literal lookup and every term appears, case-insensitively, in a passage;
 *  - unknown (no_rerank): no rerank ran (keyword-only or fused order), so there is no score to judge;
 *  - strong or weak (rerank): the top rerank score is at least the threshold, or below it (or nothing was reranked).
 * A rerank score measures relevance, not whether a passage states the answer: a passage about the right person or
 * document can score high and still lack the detail asked for, so strong is not proof of an answer.
 */
export function judgeEvidence(
  r: { degraded: Degraded; topScore: number | null; query: string; passages: { content: string }[] },
  threshold: number = config.retrieval.answerThreshold,
): Evidence {
  if (isBareLiteralLookup(r.query)) {
    const text = r.passages.map((p) => p.content.toLowerCase());
    if (triggerTerms(r.query).every((t) => text.some((c) => c.includes(t.toLowerCase())))) return { level: "strong", basis: "literal", threshold };
  }
  if (isDegraded(r.degraded)) return { level: "unknown", basis: "no_rerank", threshold };
  return { level: r.topScore !== null && r.topScore >= threshold ? "strong" : "weak", basis: "rerank", threshold };
}
