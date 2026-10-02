import { Command } from "commander";
import { makeCtx, type Ctx } from "./ctx.js";
import { config } from "./config.js";
import { readInput } from "./ingest/readers.js";
import { redoSkipped, retryFailed, stageCounts, STAGES, spendCapAdvice, type Stage } from "./ingest/pipeline.js";
import { ingestAll, ingestLine, logSkip } from "./ingest/batch.js";
import { parseAuthor } from "./ingest/author.js";
import { search, type SearchOptions } from "./retrieve/search.js";
import { ask } from "./retrieve/ask.js";
import { degradedNote, searchMode } from "./retrieve/contract.js";

function parseMeta(pairs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs ?? []) {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

async function withCtx(fn: (ctx: Ctx) => Promise<void>): Promise<void> {
  const ctx = makeCtx();
  try {
    await fn(ctx);
  } finally {
    // Write the Obsidian mirror for anything this command saved before the process exits.
    try {
      await ctx.obsidian?.close();
    } finally {
      await ctx.sql.end();
    }
  }
}

function searchOptions(opts: { kind?: string[]; since?: string; until?: string; verified?: boolean; k?: string }): SearchOptions {
  return {
    sourceKinds: opts.kind?.length ? opts.kind : undefined,
    since: opts.since ? new Date(opts.since) : undefined,
    until: opts.until ? new Date(opts.until) : undefined,
    verifiedOnly: opts.verified ?? false,
    k: opts.k ? Number(opts.k) : undefined,
  };
}

const program = new Command().name("brain").description("Personal knowledge base").version("0.1.0");

program
  .command("ingest <input>")
  .description("Ingest a file, directory, URL, or - for stdin")
  .option("--kind <kind>", "source kind label (note, conversation, news, job_description, ...)", "paste")
  .option("--author <author>", "who wrote it: owner, other or unknown (default by kind: note, paste, conversation, resume → owner; news, paper, job_description, email → other; else unknown)")
  .option("--title <title>", "override the detected title")
  .option("--occurred-at <date>", "date the content is about (ISO 8601)")
  .option("--meta <k=v...>", "extra metadata pairs")
  .option("--until <stage>", `stop after this stage (${STAGES.join(", ")})`)
  .action(async (input: string, opts) => {
    if (opts.until && !STAGES.includes(opts.until)) throw new Error(`Unknown stage ${opts.until}`);
    const author = opts.author === undefined ? undefined : parseAuthor(opts.author);
    await withCtx(async (ctx) => {
      const meta = parseMeta(opts.meta);
      const { ok, failed } = await ingestAll(
        ctx,
        await readInput(input),
        {
          until: opts.until as Stage | undefined,
          toInput: (r) => ({
            text: r.text,
            title: opts.title ?? r.title,
            sourceKind: opts.kind,
            author,
            origin: r.origin,
            mimeType: r.mimeType,
            metadata: { ...r.metadata, ...meta },
            occurredAt: opts.occurredAt ? new Date(opts.occurredAt) : null,
          }),
        },
        {
          done: (r, res) => console.log(ingestLine(r, res, author)),
          skip: logSkip,
        },
      );
      if (ok.some((o) => o.result.spendCap)) console.error(spendCapAdvice(ctx.voyageCap?.name));
      if (failed.length) process.exitCode = 1;
    });
  });

program
  .command("status")
  .description("Pipeline stage counts, failures, and documents whose items about the owner were suppressed")
  .action(async () => {
    const { suppressedDocuments } = await import("./ingest/set-author.js");
    await withCtx(async (ctx) => {
      for (const s of await stageCounts(ctx)) console.log(`${s.stage.padEnd(10)} ${String(s.count).padStart(6)} ${s.failed ? `(${s.failed} failed)` : ""}`);
      const failed = await ctx.sql<{ document_id: string; stage: string; error: string; attempts: number }[]>`
        select document_id, stage, error, attempts from brain.ingest_jobs where error is not null order by updated_at desc limit 20`;
      for (const f of failed) console.log(`  ${f.document_id} at ${f.stage} (${f.attempts} attempts): ${f.error}`);
      const suppressed = await suppressedDocuments(ctx.sql);
      if (suppressed.length) {
        console.log("suppressed facts/relations about the owner (the owner did not write the document):");
        for (const s of suppressed) console.log(`  ${s.documentId} ${String(s.count).padStart(3)}  ${s.title ?? "(untitled)"} [${s.author}]`);
      }
    });
  });

program
  .command("retry")
  .description("Re-run every job that is not done")
  .option("--stage <stage>", "only jobs currently at this stage")
  .option("--skipped", "redo documents whose summary or extraction was skipped (stubbed after a refusal or schema failure)")
  .option("--limit <n>", "max jobs", "1000")
  .action(async (opts) => {
    await withCtx(async (ctx) => {
      const limit = Number(opts.limit);
      const results = opts.skipped ? await redoSkipped(ctx, { limit }) : await retryFailed(ctx, { stage: opts.stage as Stage | undefined, limit });
      for (const r of results) {
        console.log(`${r.documentId} ${r.stage}${r.skipped ? " (busy, left alone)" : ""}${r.error ? " ERROR " + r.error : ""}`);
      }
      if (results.some((r) => r.spendCap)) console.log(spendCapAdvice(ctx.voyageCap?.name));
    });
  });

program
  .command("search <query>")
  .description("Hybrid search with graph expansion")
  .option("--kind <kind...>", "filter by source kind")
  .option("--since <date>")
  .option("--until <date>")
  .option("--verified", "only verified facts and entities")
  .option("-k <n>", "number of passages")
  .option("--json", "print the full result as JSON")
  .action(async (query: string, opts) => {
    await withCtx(async (ctx) => {
      const res = await search(ctx, query, { ...searchOptions(opts), client: "cli" });
      if (opts.json) return void console.log(JSON.stringify(res, null, 2));
      const note = degradedNote(res.degraded);
      console.log(`mode: ${searchMode(res.degraded)}${note ? ` (${note})` : ""}\n`);
      if (res.fallbackUsed) console.log("(weak match: included raw substring hits)\n");
      res.passages.forEach((p, i) => {
        console.log(`[P${i + 1}] ${p.layers.join("+")} ${p.score === null ? "-" : p.score.toFixed(3)} ${p.sourceKind}${p.title ? " · " + p.title : ""}`);
        console.log(`     ${p.content.replace(/\s+/g, " ").slice(0, 240)}\n`);
      });
      if (res.documents.length) console.log("Documents: " + res.documents.map((d) => d.title ?? d.documentId).join(" | "));
      for (const e of res.entities) console.log(`Entity ${e.type}: ${e.name} -> ${e.neighbors.map((n) => `${n.name} (${n.type})`).join(", ") || "no neighbors"}`);
      if (res.facts.length) console.log("Facts: " + res.facts.map((f) => `${f.predicate}=${f.objectText}`).join("; "));
    });
  });

program
  .command("ask <question>")
  .description("Answer a question with citations")
  .option("--kind <kind...>")
  .option("--since <date>")
  .option("--until <date>")
  .option("--verified")
  .action(async (question: string, opts) => {
    await withCtx(async (ctx) => {
      const { answer, result } = await ask(ctx, question, searchOptions(opts));
      console.log(answer + "\n");
      result.passages.forEach((p, i) => console.log(`[P${i + 1}] ${p.sourceKind}${p.title ? " · " + p.title : ""} (${p.documentId})`));
      result.facts.forEach((f, i) => console.log(`[F${i + 1}] ${f.predicate}: ${f.objectText}`));
    });
  });

program
  .command("node <nameOrId>")
  .description("Show a node with its facts, edges and evidence")
  .action(async (nameOrId: string) => {
    const { describeNode } = await import("./graph/inspect.js");
    await withCtx(async (ctx) => {
      const r = await describeNode(ctx.sql, nameOrId);
      if (!r) return void console.log("No such node");
      console.log(`${r.type}: ${r.name}${r.verified ? " (verified)" : ""}  ${r.id}`);
      if (r.aliases.length) console.log(`aliases: ${r.aliases.join(", ")}`);
      console.log(`properties: ${JSON.stringify(r.properties)}`);
      for (const e of r.edges) {
        console.log(`  ${e.direction === "out" ? "->" : "<-"} ${e.type} ${e.otherName} (${e.otherType})`);
        if (e.evidence) console.log(`       "${e.evidence.replace(/\s+/g, " ")}"${e.evidenceDocumentTitle ? ` — ${e.evidenceDocumentTitle}` : ""}`);
      }
      for (const f of r.facts) console.log(`  fact ${f.predicate}: ${f.objectText}${f.verified ? "" : " (unverified)"}`);
      console.log(`mentioned in ${r.mentionCount} passages across ${r.mentionedIn.length} documents`);
    });
  });

program
  .command("facts")
  .description("Current facts about the owner, with ids")
  .option("--all", "include superseded and expired facts")
  .action(async (opts) => {
    const { listFacts } = await import("./graph/facts.js");
    await withCtx(async (ctx) => {
      for (const f of await listFacts(ctx.sql, Boolean(opts.all))) {
        const flags = [
          f.verified ? `verified by ${f.verifiedBy}` : `unverified, ${f.verifiedBy ?? "unknown"}`,
          f.supersededBy ? "superseded" : null,
          f.validTo ? `until ${f.validTo.toISOString().slice(0, 10)}` : null,
        ].filter(Boolean).join("; ");
        console.log(`${f.id}  ${f.predicate.padEnd(24)} ${f.objectText}  (${flags})`);
      }
    });
  });

program
  .command("verify-fact <id>")
  .description("Mark a fact as verified by you")
  .action(async (id: string) => {
    const { verifyFact } = await import("./graph/facts.js");
    const { refreshMirror } = await import("./obsidian/auto.js");
    await withCtx(async (ctx) => {
      const ok = await verifyFact(ctx.sql, id, "frank");
      if (ok) refreshMirror(ctx); // written when withCtx closes the projector
      console.log(ok ? "verified" : "no such fact");
    });
  });

program
  .command("set-author <documentId> <author>")
  .description("Change who wrote a document (owner, other, unknown) and redo the facts and relationships it produced")
  .action(async (documentId: string, authorArg: string) => {
    const { setAuthor, setAuthorLines } = await import("./ingest/set-author.js");
    const author = parseAuthor(authorArg);
    await withCtx(async (ctx) => {
      for (const line of setAuthorLines(await setAuthor(ctx, documentId, author))) console.log(line);
    });
  });

program
  .command("usage")
  .description("Voyage tokens per UTC day and operation, refused calls, errors, and the estimated cost")
  .option("--days <n>", "UTC days to show, today included", "30")
  .action(async (opts) => {
    const days = Number(opts.days);
    if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error(`--days needs a whole number from 1 to 366, got ${JSON.stringify(opts.days)}`);
    const { usageByDay, formatUsage } = await import("./llm/usage.js");
    const { tokensToday } = await import("./llm/ledger.js");
    await withCtx(async (ctx) => {
      const lines = formatUsage(await usageByDay(ctx.sql, days), {
        days,
        tokensToday: await tokensToday(ctx.sql),
        cap: (ctx.voyageCap ?? { tokens: config.voyageDailyTokenCap }).tokens,
        prices: { embed: config.voyagePricePerMTokEmbed, rerank: config.voyagePricePerMTokRerank },
      });
      for (const l of lines) console.log(l);
    });
  });

const evalCmd = program.command("eval").description("Retrieval eval against the brain_eval database (never the real one)");

evalCmd
  .command("ingest [dir]")
  .description("Ingest a corpus directory into the eval database (default eval/corpus)")
  .action(async (dir: string | undefined) => {
    const { makeEvalCtx } = await import("./eval/db.js");
    const { ingestCorpus } = await import("./eval/run.js");
    const ctx = makeEvalCtx();
    try {
      if ((await ingestCorpus(ctx, dir ?? "eval/corpus")) > 0) process.exitCode = 1;
    } finally {
      await ctx.sql.end();
    }
  });

evalCmd
  .command("run")
  .description("Run the golden set and report metrics; --compare shows deltas against eval/baseline.json")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--baseline <path>", "baseline file", "eval/baseline.json")
  .option("--compare", "compare against the baseline")
  .option("--gate", "exit 1 when the comparison fails the gate (implies --compare)")
  .option("--accept", "overwrite the baseline with this run")
  .option("--json")
  .action(async (opts) => {
    const { makeEvalCtx } = await import("./eval/db.js");
    const { runEval, attributionGate, evalVoyageLine } = await import("./eval/run.js");
    const { compare, gateFailures, loadBaseline, saveBaseline } = await import("./eval/baseline.js");
    const { abstained, falseAnswer } = await import("./eval/metrics.js");
    const { execSync } = await import("node:child_process");
    const ctx = makeEvalCtx();
    try {
      const run = await runEval(ctx, opts.golden);
      const base = opts.compare || opts.gate ? await loadBaseline(opts.baseline) : null;
      const goldenIds = run.results.map((r) => r.id).sort();
      const comparison = base ? compare(base, run.report, run.ranks, goldenIds) : null;
      const failures = gateFailures(comparison, { gate: !!opts.gate, accept: !!opts.accept, baselinePath: opts.baseline });
      if (opts.gate) failures.push(...attributionGate(run.attribution));
      if (opts.json) {
        console.log(JSON.stringify({ ...run, comparison, failures }, null, 2));
      } else {
        for (const r of run.results) {
          const rank = run.ranks[r.id];
          const threshold = config.retrieval.fallbackThreshold;
          // A negative below threshold that still got a graph passage is neither abstained nor a false answer.
          const negTag = falseAnswer(r, threshold) ? "FALSE" : abstained(r, threshold) ? "abst." : "GRAPH";
          const tag = r.negative ? negTag : rank === null ? "MISS" : `#${String(rank).padStart(2)}`;
          console.log(`${tag.padEnd(5)} ${r.kind.padEnd(11)} ${r.degraded ? "DEGRADED " : ""}${r.id}  ${r.ranked.length ? "" : "(no passages) "}${r.totalMs}ms`);
        }
        const o = run.report.overall;
        console.log(`\noverall  n=${o.n}  recall@1=${o.recallAt1.toFixed(2)}  recall@5=${o.recallAt5.toFixed(2)}  recall@10=${o.recallAt10.toFixed(2)}  mrr=${o.mrr.toFixed(2)}  ndcg@10=${o.ndcgAt10 === null ? "n/a" : o.ndcgAt10.toFixed(2)}`);
        for (const [kind, m] of Object.entries(run.report.byKind)) console.log(`${kind.padEnd(11)} n=${m.n}  recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}`);
        const ng = run.report.negatives;
        if (ng.n) console.log(`negatives   n=${ng.n}  abstention=${ng.abstentionRate.toFixed(2)}  false-answer=${ng.falseAnswerRate.toFixed(2)}`);
        if (run.report.paraphrase.n) console.log(`paraphrase  n=${run.report.paraphrase.n}  consistency=${run.report.paraphrase.consistency.toFixed(2)}  mean-recall@10-delta=${run.report.paraphrase.meanRecallDelta >= 0 ? "+" : ""}${run.report.paraphrase.meanRecallDelta.toFixed(3)}`);
        console.log(`degraded=${(run.report.degradedFraction * 100).toFixed(0)}%  latency p50=${run.report.latencyMs.p50}ms p95=${run.report.latencyMs.p95}ms`);
        console.log(`attribution  self-facts-from-others=${run.attribution.selfFacts}  self-edges-from-others=${run.attribution.selfEdges}`);
        console.log(evalVoyageLine(run.voyage));
        if (comparison) {
          const d = comparison.deltas;
          console.log(`\nvs baseline  recall@10 ${d.recallAt10 >= 0 ? "+" : ""}${d.recallAt10.toFixed(3)}  mrr ${d.mrr >= 0 ? "+" : ""}${d.mrr.toFixed(3)}`);
          if (comparison.goldenChanged) console.log("  golden set changed since the baseline: deltas compare different question sets");
          for (const r of comparison.regressions) console.log(`  worse   ${r.id}: ${r.before ?? "miss"} -> ${r.after ?? "miss"}`);
          for (const r of comparison.improvements) console.log(`  better  ${r.id}: ${r.before ?? "miss"} -> ${r.after ?? "miss"}`);
          for (const f of failures) console.log(`  GATE: ${f}`);
        } else if (opts.compare || opts.gate) {
          console.log("\nno baseline yet; run with --accept to record one");
          for (const f of failures) console.log(`  GATE: ${f}`);
        }
      }
      if (failures.length) process.exitCode = 1;
      if (opts.accept) {
        const commit = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
        await saveBaseline(opts.baseline, { recordedAt: new Date().toISOString(), commit, goldenIds, report: run.report, ranks: run.ranks });
        console.log(`baseline written to ${opts.baseline} at ${commit}`);
      }
    } finally {
      await ctx.sql.end();
    }
  });

program
  .command("backfill")
  .description("Run summarize and extract for every unfinished document through the Batches API (needs ANTHROPIC_API_KEY; half price, slower)")
  .option("--limit <n>", "max documents per stage", "500")
  .option("--poll <seconds>", "poll interval", "30")
  .action(async (opts) => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("backfill uses the Batches API and needs ANTHROPIC_API_KEY; normal ingestion does not");
    const { backfill } = await import("./ingest/backfill.js");
    await withCtx((ctx) => backfill(ctx, { limit: Number(opts.limit), pollMs: Number(opts.poll) * 1000 }));
  });

program
  .command("project-obsidian")
  .description("Write a read-only mirror of the graph into an Obsidian vault folder")
  .option("--vault <path>", "vault path (default from OBSIDIAN_VAULT_PATH)")
  .option("--folder <name>", "folder inside the vault (default Brain)")
  .option("--watch <minutes>", "re-run every N minutes")
  .option("--list-vaults", "print vaults Obsidian knows about and exit")
  .action(async (opts) => {
    if (opts.listVaults) {
      const { listVaults } = await import("./obsidian/vaults.js");
      for (const v of await listVaults()) console.log(`${v.open ? "*" : " "} ${v.name.padEnd(16)} ${v.path}`);
      return;
    }
    const minutes = opts.watch === undefined ? null : Number(opts.watch);
    if (minutes !== null && !(minutes > 0)) throw new Error(`--watch needs a positive number of minutes, got ${JSON.stringify(opts.watch)}`);
    const { projectObsidian } = await import("./obsidian/project.js");
    await withCtx(async (ctx) => {
      const run = async () => {
        const r = await projectObsidian(ctx, { vault: opts.vault, folder: opts.folder });
        console.log(`${new Date().toISOString()} written ${r.written}, unchanged ${r.unchanged}, deleted ${r.deleted}${r.skipped.length ? `, left alone: ${r.skipped.join(", ")}` : ""}`);
      };
      await run();
      if (minutes !== null) {
        let running = false;
        await new Promise<never>(() =>
          setInterval(() => {
            if (running) return; // previous run still going; skip this tick rather than stack runs
            running = true;
            run()
              .catch((e) => console.error(e instanceof Error ? e.message : e))
              .finally(() => (running = false));
          }, minutes * 60_000),
        );
      }
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
