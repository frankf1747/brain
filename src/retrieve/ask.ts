import type { Ctx } from "../ctx.js";
import { search, type SearchOptions, type SearchResult } from "./search.js";
import { degradedNote } from "./contract.js";
import { factLine, foundBy, scoreText } from "../mcp/render.js";
import { claimsFromAnswer } from "../verify/answer.js";
import { verifyClaims, type Verification } from "../verify/resolve.js";

export const ASK_SYSTEM =
  "You answer questions for the owner of a personal knowledge base using only the passages and facts provided. Cite passages as [P1], [P2] and facts as [F1], [F2] right after the claim they support. If the material does not contain the answer, say so plainly. Never state anything the material does not support. " +
  "Each passage shows its score and who wrote it: a rerank score runs from 0 to 1 and higher is stronger; rrf or - means the passage was not reranked. A passage whose author is not the owner says what someone else wrote, not what is true of the owner. When the search mode is not hybrid, or every score is low, say the evidence is weak.";

/** The prompt: the question, how the search ran, then facts and passages with their provenance. */
export function buildAskPrompt(question: string, result: SearchResult): string {
  const note = degradedNote(result.degraded);
  const header = [
    `Search mode: ${result.mode}${note ? ` (${note})` : ""}`,
    ...(result.fallbackUsed ? ["Weak match: some passages are literal substring hits (fallback), not ranked passages."] : []),
  ].join("\n");
  const passages = result.passages
    .map((p, i) => `[P${i + 1}] ${scoreText(p)} · ${foundBy(p)} · author: ${p.author} · ${p.sourceKind}${p.title ? ": " + p.title : ""}\n${p.content}`)
    .join("\n\n");
  const facts = result.facts.map((f, i) => factLine(f, i)).join("\n");
  return `Question: ${question}\n\n${header}\n\nFacts about the owner:\n${facts || "(none)"}\n\nPassages:\n${passages || "(none)"}`;
}

export interface AskResult {
  answer: string;
  result: SearchResult;
  /** The answer checked sentence by sentence against what each sentence cites; null when it has no sentence or the check failed. */
  verification: Verification | null;
  /** Why the check failed (the answer is still returned); null when it ran or there was nothing to check. */
  verificationError: string | null;
  /** Sentences past the first 50, which were not checked. */
  droppedClaims: number;
}

/**
 * Searches, asks the model to answer from the result, then checks the answer with the citation verifier: each
 * sentence is a claim citing the [P#]/[F#] labels inside it, resolved through this search's retrieval id. The check
 * makes no model call; a failure there is reported in verificationError and never loses the answer.
 */
export async function ask(ctx: Ctx, question: string, opts: SearchOptions = {}): Promise<AskResult> {
  const client = opts.client ?? "ask";
  const result = await search(ctx, question, { ...opts, client });
  const answer = await ctx.llm.text({ system: ASK_SYSTEM, user: buildAskPrompt(question, result) });
  const { claims, dropped } = claimsFromAnswer(answer);
  let verification: Verification | null = null;
  let verificationError: string | null = null;
  if (claims.length) {
    try {
      verification = await verifyClaims(ctx.sql, result.retrievalId, claims, { client });
    } catch (e) {
      verificationError = e instanceof Error ? e.message : String(e);
    }
  }
  return { answer, result, verification, verificationError, droppedClaims: dropped };
}
