import { Command } from "commander";
import { makeCtx, type Ctx } from "./ctx.js";
import { readInput } from "./ingest/readers.js";
import { ingest, retryFailed, stageCounts, STAGES, type Stage } from "./ingest/pipeline.js";
import { search, type SearchOptions } from "./retrieve/search.js";
import { ask } from "./retrieve/ask.js";
import { canonicalName } from "./text/normalize.js";

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
      for (const r of await readInput(input)) {
        const res = await ingest(
          ctx,
          {
            text: r.text,
            title: opts.title ?? r.title,
            sourceKind: opts.kind,
            origin: r.origin,
            mimeType: r.mimeType,
            metadata: { ...r.metadata, ...parseMeta(opts.meta) },
            occurredAt: opts.occurredAt ? new Date(opts.occurredAt) : null,
          },
          { until: opts.until as Stage | undefined },
        );
        console.log(`${res.created ? "new " : "dup "} ${res.id} ${res.stage.padEnd(10)} ${res.error ? "ERROR " + res.error + " " : ""}${r.origin}`);
      }
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
  .option("--limit <n>", "max jobs", "1000")
  .action(async (opts) => {
    await withCtx(async (ctx) => {
      for (const r of await retryFailed(ctx, { stage: opts.stage as Stage | undefined, limit: Number(opts.limit) })) {
        console.log(`${r.documentId} ${r.stage}${r.error ? " ERROR " + r.error : ""}`);
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
    await withCtx(async (ctx) => {
      const isUuid = /^[0-9a-f-]{36}$/i.test(nameOrId);
      const key = canonicalName(nameOrId);
      const [node] = await ctx.sql<{ id: string; type: string; name: string; aliases: string[]; properties: unknown; verified: boolean }[]>`
        select x.id, x.type, x.name, x.aliases, x.properties, x.verified
        from brain.nodes n join brain.nodes x on x.id = brain.canonical_node(n.id)
        where ${isUuid ? ctx.sql`n.id = ${nameOrId}` : ctx.sql`(n.canonical_name = ${key} or ${key} = any(n.aliases))`}
        limit 1`;
      if (!node) return void console.log("No such node");
      console.log(`${node.type}: ${node.name}${node.verified ? " (verified)" : ""}  ${node.id}`);
      if (node.aliases.length) console.log(`aliases: ${node.aliases.join(", ")}`);
      console.log(`properties: ${JSON.stringify(node.properties)}`);
      const edges = await ctx.sql<{ dir: string; type: string; other: string; other_type: string; evidence: string | null }[]>`
        select case when e.from_node = ${node.id} then '->' else '<-' end as dir, e.type,
               o.name as other, o.type as other_type, left(c.content, 160) as evidence
        from brain.edges e
        join brain.nodes o on o.id = case when e.from_node = ${node.id} then e.to_node else e.from_node end
        left join brain.chunks c on c.id = e.evidence_chunk_id
        where e.from_node = ${node.id} or e.to_node = ${node.id}
        order by e.type`;
      for (const e of edges) console.log(`  ${e.dir} ${e.type} ${e.other} (${e.other_type})${e.evidence ? `\n       "${e.evidence.replace(/\s+/g, " ")}"` : ""}`);
      const facts = await ctx.sql<{ predicate: string; object_text: string }[]>`select predicate, object_text from brain.current_facts(${node.id})`;
      for (const f of facts) console.log(`  fact ${f.predicate}: ${f.object_text}`);
      const mentions = await ctx.sql<{ n: string }[]>`select count(*)::text as n from brain.mentions where node_id = ${node.id}`;
      console.log(`mentioned in ${mentions[0].n} passages`);
    });
  });

program
  .command("facts")
  .description("Current facts about the owner")
  .option("--all", "include superseded and expired facts")
  .action(async (opts) => {
    await withCtx(async (ctx) => {
      const rows = opts.all
        ? await ctx.sql<{ predicate: string; object_text: string; verified: boolean; valid_to: Date | null; superseded_by: string | null }[]>`
            select predicate, object_text, verified, valid_to, superseded_by from brain.facts
            where subject_id = (select id from brain.nodes where is_self) order by predicate, created_at`
        : await ctx.sql<{ predicate: string; object_text: string; verified: boolean; valid_to: Date | null; superseded_by: null }[]>`
            select predicate, object_text, verified, valid_to, null as superseded_by from brain.current_facts(null)`;
      for (const f of rows) {
        const flags = [f.verified ? "verified" : "unverified", f.superseded_by ? "superseded" : null, f.valid_to ? `until ${f.valid_to.toISOString().slice(0, 10)}` : null].filter(Boolean).join(", ");
        console.log(`${f.predicate.padEnd(24)} ${f.object_text}  (${flags})`);
      }
    });
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
      if (opts.ingest) await ingestCorpus(ctx, opts.ingest);
      const { scored, summary } = await runEval(ctx, opts.golden);
      if (opts.json) return void console.log(JSON.stringify({ scored, summary }, null, 2));
      for (const s of scored) console.log(`${s.rank === null ? "MISS" : `#${String(s.rank).padStart(2)}`}  ${s.needs.padEnd(9)} ${s.question}`);
      console.log(`\noverall  recall@10=${summary.overall.recallAt10.toFixed(2)}  mrr=${summary.overall.mrr.toFixed(2)}  n=${summary.overall.n}`);
      for (const [needs, m] of Object.entries(summary.byNeeds)) console.log(`${needs.padEnd(9)} recall@10=${m.recallAt10.toFixed(2)}  mrr=${m.mrr.toFixed(2)}  n=${m.n}`);
    });
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
