import { Command } from "commander";
import { makeCtx, type Ctx } from "./ctx.js";
import { readInput } from "./ingest/readers.js";
import { redoSkipped, retryFailed, stageCounts, STAGES, type Stage } from "./ingest/pipeline.js";
import { ingestAll, logSkip } from "./ingest/batch.js";
import { search, type SearchOptions } from "./retrieve/search.js";
import { ask } from "./retrieve/ask.js";

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
    await ctx.sql.end();
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
  .option("--title <title>", "override the detected title")
  .option("--occurred-at <date>", "date the content is about (ISO 8601)")
  .option("--meta <k=v...>", "extra metadata pairs")
  .option("--until <stage>", `stop after this stage (${STAGES.join(", ")})`)
  .action(async (input: string, opts) => {
    if (opts.until && !STAGES.includes(opts.until)) throw new Error(`Unknown stage ${opts.until}`);
    await withCtx(async (ctx) => {
      const meta = parseMeta(opts.meta);
      const { failed } = await ingestAll(
        ctx,
        await readInput(input),
        {
          until: opts.until as Stage | undefined,
          toInput: (r) => ({
            text: r.text,
            title: opts.title ?? r.title,
            sourceKind: opts.kind,
            origin: r.origin,
            mimeType: r.mimeType,
            metadata: { ...r.metadata, ...meta },
            occurredAt: opts.occurredAt ? new Date(opts.occurredAt) : null,
          }),
        },
        {
          done: (r, res) => console.log(`${res.created ? "new " : "dup "} ${res.id} ${res.stage.padEnd(10)} ${res.error ? "ERROR " + res.error + " " : ""}${r.origin}`),
          skip: logSkip,
        },
      );
      if (failed.length) process.exitCode = 1;
    });
  });

program
  .command("status")
  .description("Pipeline stage counts and failures")
  .action(async () => {
    await withCtx(async (ctx) => {
      for (const s of await stageCounts(ctx)) console.log(`${s.stage.padEnd(10)} ${String(s.count).padStart(6)} ${s.failed ? `(${s.failed} failed)` : ""}`);
      const failed = await ctx.sql<{ document_id: string; stage: string; error: string; attempts: number }[]>`
        select document_id, stage, error, attempts from brain.ingest_jobs where error is not null order by updated_at desc limit 20`;
      for (const f of failed) console.log(`  ${f.document_id} at ${f.stage} (${f.attempts} attempts): ${f.error}`);
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
      if (res.usedFallback) console.log("(weak match: included raw substring hits)\n");
      res.passages.forEach((p, i) => {
        console.log(`[P${i + 1}] ${p.group} ${p.score.toFixed(3)} ${p.sourceKind}${p.documentTitle ? " · " + p.documentTitle : ""}`);
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
      result.passages.forEach((p, i) => console.log(`[P${i + 1}] ${p.sourceKind}${p.documentTitle ? " · " + p.documentTitle : ""} (${p.documentId})`));
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
    await withCtx(async (ctx) => console.log((await verifyFact(ctx.sql, id, "frank")) ? "verified" : "no such fact"));
  });

program
  .command("eval")
  .description("Run the golden set and report recall@10 and MRR")
  .option("--golden <path>", "golden set file", "eval/golden.jsonl")
  .option("--ingest <dir>", "ingest this corpus directory first")
  .option("--json")
  .action(async (opts) => {
    const { runEval, ingestCorpus } = await import("./eval/run.js");
    await withCtx(async (ctx) => {
      if (opts.ingest && (await ingestCorpus(ctx, opts.ingest)) > 0) process.exitCode = 1;
      const { scored, summary } = await runEval(ctx, opts.golden);
      if (opts.json) return void console.log(JSON.stringify({ scored, summary }, null, 2));
      for (const s of scored) console.log(`${s.rank === null ? "MISS" : `#${String(s.rank).padStart(2)}`}  ${s.needs.padEnd(9)} ${s.question}`);
      console.log(`\noverall  recall@10=${summary.overall.recallAt10.toFixed(2)}  mrr=${summary.overall.mrr.toFixed(2)}  n=${summary.overall.n}`);
      for (const [needs, m] of Object.entries(summary.byNeeds)) console.log(`${needs.padEnd(9)} recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}  n=${m.n}`);
    });
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
