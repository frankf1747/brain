import type { Ctx } from "../ctx.js";
import { search, type SearchOptions, type SearchResult } from "./search.js";

export const ASK_SYSTEM =
  "You answer questions for the owner of a personal knowledge base using only the passages and facts provided. Cite passages as [P1], [P2] and facts as [F1], [F2] right after the claim they support. If the material does not contain the answer, say so plainly. Never state anything the material does not support.";

export function buildAskPrompt(question: string, result: SearchResult): string {
  const passages = result.passages
    .map((p, i) => `[P${i + 1}] (${p.sourceKind}${p.title ? ": " + p.title : ""})\n${p.content}`)
    .join("\n\n");
  const facts = result.facts
    .map((f, i) => `[F${i + 1}] ${f.predicate}: ${f.objectText}${f.verified ? "" : " (unverified)"}`)
    .join("\n");
  return `Question: ${question}\n\nFacts about the owner:\n${facts || "(none)"}\n\nPassages:\n${passages || "(none)"}`;
}

export async function ask(ctx: Ctx, question: string, opts: SearchOptions = {}): Promise<{ answer: string; result: SearchResult }> {
  const result = await search(ctx, question, { ...opts, client: opts.client ?? "ask" });
  const answer = await ctx.llm.text({ system: ASK_SYSTEM, user: buildAskPrompt(question, result) });
  return { answer, result };
}
