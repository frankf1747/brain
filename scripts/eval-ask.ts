// Runs `brain ask` against brain_eval on chosen golden items and writes one JSON line per item: the question, the
// search's evidence level, the model's answer and the citation check's verdicts. Judging whether each answer declined
// or answered is left to a reader; eval/ask/2026-10-04-heldout.jsonl holds one such run, judged by an agent.
// Usage: OBSIDIAN_AUTO=0 npx tsx scripts/eval-ask.ts <out.jsonl> <golden id>...
import { appendFileSync, writeFileSync } from "node:fs";
import { makeEvalCtx, assertEvalConnection } from "../src/eval/db.js";
import { loadGolden } from "../src/eval/golden.js";
import { ask } from "../src/retrieve/ask.js";

const [out, ...ids] = process.argv.slice(2);
if (!out || ids.length === 0) throw new Error("usage: scripts/eval-ask.ts <out.jsonl> <golden id>...");
const wanted = new Set(ids);
const items = (await loadGolden("eval/golden.jsonl")).filter((g) => wanted.has(g.id));
const ctx = makeEvalCtx("fixtures");
try {
  await assertEvalConnection(ctx.sql);
  writeFileSync(out, "");
  for (const it of items) {
    const r = await ask(ctx, it.question, { client: "eval" });
    appendFileSync(out, JSON.stringify({ id: it.id, question: it.question, evidence: r.result.evidence.level, answer: r.answer, verdicts: r.verification?.summary.text ?? null }) + "\n");
    console.log(it.id, r.result.evidence.level);
  }
} finally {
  await ctx.sql.end();
}
