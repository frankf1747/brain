import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { splitFrontMatter, normalizeWhitespace, kindFromFilename } from "../../src/eval/run.js";
import { defaultAuthor } from "../../src/ingest/author.js";

/**
 * The fixture corpus, file by file: who wrote it, its title, and the sentences each file must contain verbatim. The
 * golden set and eval/verifier.jsonl quote these files, and the briefs in the Phase 6 plan were written against this
 * list, so a rewrite of any file keeps the facts it plants. The first nine files predate Phase 6 and are checked for
 * title and author only (eval/verifier.jsonl and test/unit/verifier-fixtures.test.ts pin their text).
 */
const CORPUS: Record<string, { author: "owner" | "other"; title: string; required?: string[]; forbidden?: string[] }> = {
  "conversation--interview-prep-with-priya.md": { author: "owner", title: "Interview prep call with Priya Natarajan" },
  "email--recruiter-followup-beta-ventures.md": { author: "other", title: "Re: Analyst opening at a Beta Ventures portfolio company" },
  "email--recruiter-intro.md": { author: "other", title: "Introducing Frank Fu for the Northwind Robotics analytics lead opening" },
  "job_description--acme-senior-data-analyst.md": { author: "other", title: "Senior Data Analyst, Acme Corp (Austin, TX)" },
  "news--acme-series-b.md": { author: "other", title: "Acme Corp raises $40M Series B led by Beta Ventures" },
  "note--databricks-cost-governance.md": { author: "other", title: "What a runaway Databricks bill taught me about cost governance" },
  "note--fairness-in-ml.md": { author: "owner", title: "Notes on fairness in machine learning" },
  "note--moved-to-denver.md": { author: "owner", title: "Moved to Denver" },
  "paper--contextual-retrieval-abstract.md": { author: "other", title: "Contextual Retrieval: prepending document context to chunks" },
  "note--settling-in-austin.md": {
    author: "owner", title: "Settling in Austin",
    required: ["Date: 2026-03-02", "I live in Austin now, in a one-bedroom apartment in East Austin.", "My lease runs for twelve months, through February 2027.", "I am on F-1 OPT"],
    forbidden: ["Denver"],
  },
  "note--job-search-priorities.md": {
    author: "owner", title: "Job search priorities, end of September",
    required: [
      "Date: 2026-09-28", "I am targeting analytics lead or senior data analyst roles.", "My minimum base salary is $130,000.",
      "Northwind Robotics is my first choice and Acme Corp is my second.", "Any role must be based in Denver or fully remote, because I moved to Denver this month.",
      "I still need an employer that will sponsor an H-1B.", "Wei Zhang, who now works at Northwind, says the analytics team is growing.",
    ],
  },
  "job_description--acme-data-analyst-ii.md": {
    author: "other", title: "Data Analyst II, Acme Corp (Austin, TX)",
    required: [
      "Requisition REQ-4417.", "Support the ZX-9000 service team with weekly warranty reports.", "## Compensation and visa", "Base salary range $92,000 to $108,000.",
      "Acme does not sponsor visas for this role.", "On-site five days a week in the Austin office.", "Hiring manager: Priya Natarajan.",
      "The team reports to Luis Ortega, VP of Operations.",
    ],
  },
  "job_description--northwind-analytics-lead.md": {
    author: "other", title: "Analytics Lead, Northwind Robotics (Denver, CO)",
    required: [
      "Requisition NWR-0912.", "You will lead a team of four analysts", "Reports to Taylor Brooks, VP of Operations.", "Base salary range $150,000 to $175,000.",
      "Northwind sponsors H-1B transfers and new H-1B petitions for this role.", "Hybrid, two days a week in the Denver office.",
    ],
  },
  "meeting--acme-case-study-panel.md": {
    author: "owner", title: "Acme case study panel, transcript",
    required: [
      "Date: 2026-09-29", "ZX-9000",
      "Frank: Failures cluster in units built in the third quarter of 2025, and almost all of those used bearings from Kessler Bearings.",
      "The field-failure rate was 4.2 percent for those units against 1.1 percent for the rest.",
      "Luis Ortega: The role needs three days a week in Austin, but we can offer $8,000 in relocation support.",
      "Priya Natarajan: We will make a decision by October 10.",
    ],
  },
  "paper--late-interaction-reranking-abstract.md": {
    author: "other", title: "Late-interaction reranking for long documents",
    required: ["Abstract.", "SpanRank", "Across 12 datasets the method cut the top-20 retrieval failure rate by 21 percent", "added 38 milliseconds of latency per query"],
  },
  "news--acme-zx-9100-launch.md": {
    author: "other", title: "Acme Corp unveils the ZX-9100 drill",
    required: ["AUSTIN, September 8, 2026.", "the successor to the ZX-9000", "The ZX-9100 is priced at $1.2 million per unit", "CEO Marcus Hale", "the expanded Austin facility will add 120 jobs"],
  },
  "news--beta-ventures-fund-iii.md": {
    author: "other", title: "Beta Ventures closes $310 million Fund III",
    required: ["SAN FRANCISCO, September 15, 2026.", "Beta Ventures has closed its third fund at $310 million", "partner Dana Whitfield", "Its portfolio includes Acme Corp and Northwind Robotics.", "run by Jordan Ellis"],
  },
  "note--causal-inference-lecture-4.md": {
    author: "owner", title: "DATA 6100 lecture 4: difference-in-differences",
    required: ["Date: 2026-09-17", "DATA 6100 Causal Inference for Analysts", "Professor Elena Marsh", "The key assumption is parallel trends", "synthetic control", "Problem set 2 is due on 2026-10-08."],
  },
  "application--northwind-cover-letter.md": {
    author: "owner", title: "Cover letter: Analytics Lead, Northwind Robotics",
    required: [
      "Date: 2026-09-27", "Dear Taylor Brooks,", "Sam Okafor suggested I write to you directly", "I have four years of experience in analytics",
      "my churn model cut monthly churn by 9 percent", "I led the migration of 140 dbt models to Snowflake", "My F-1 OPT STEM extension is valid until 2027-06-30",
    ],
  },
  "note--churn-model-retro.md": {
    author: "owner", title: "Retro: Atlas churn model",
    required: [
      "Date: 2026-06-12", "We shipped the Atlas churn model in May 2026", "Brightline Analytics", "The final model reached an AUC of 0.81",
      "Monthly churn fell by 9 percent in the first quarter after launch.", "label leakage from the account_closed_at column", "Wei Zhang rebuilt the feature pipeline",
    ],
  },
  "article--metric-trees.md": {
    author: "other", title: "Metric trees: how I stopped arguing about dashboards",
    required: ["By Hannah Leclerc", "I have built metric trees at three companies over 12 years", "Start from one north-star metric", "no more than four levels deep"],
  },
  "email--acme-final-round.md": {
    author: "other", title: "Acme Senior Data Analyst: final round",
    required: [
      "From: Priya Natarajan, Hiring Manager, Acme Corp", "Date: 2026-09-30", "Hi Frank,", "Requisition REQ-4471.", "we would like to invite you to a final round on October 7",
      "We will make a decision by October 10, and any offer would need an answer by October 17.",
    ],
  },
  "email--northwind-panel-rescheduled.md": {
    author: "other", title: "Northwind panel moved to October 8",
    required: [
      "From: Sam Okafor, Technical Recruiter, Northwind Robotics", "Date: 2026-10-01", "Hi Frank,",
      "Your panel interview has moved from October 6 to October 8 at 1:00 pm Mountain Time.", "Taylor Brooks", "Ana Duarte, a senior analyst on the team, will join the panel.",
    ],
  },
  "conversation--coffee-with-jordan-ellis.md": {
    author: "owner", title: "Coffee with Jordan Ellis",
    required: [
      "Date: 2026-09-24", "Jordan said Quill Health, another Beta Ventures portfolio company, is hiring a data science manager in Boulder.",
      "he advised me to ask Northwind for a base of at least $160,000", "Dana Whitfield sits on the boards of both Acme Corp and Quill Health",
    ],
  },
  "note--visa-timeline.md": {
    author: "owner", title: "Visa timeline",
    required: [
      "Date: 2026-09-21", "My OPT STEM extension ends on 2027-06-30.", "The next H-1B registration window opens in March 2027.",
      "If I am not selected in the lottery, I have a 60-day grace period after my OPT ends.",
      "Acme Corp sponsors H-1B for the senior analyst role, and Northwind Robotics sponsors new petitions.",
    ],
  },
};

/** People and companies the graph questions traverse: each must appear in at least this many files. */
const SHARED: Record<string, number> = {
  "Priya Natarajan": 5, "Jordan Ellis": 3, "Sam Okafor": 3, "Taylor Brooks": 3, "Dana Whitfield": 3, "Wei Zhang": 2, "Luis Ortega": 2,
  "Marcus Hale": 2, "Beta Ventures": 4, "Northwind Robotics": 7, "Acme Corp": 10, "ZX-9000": 5, "Brightline Analytics": 2, "Quill Health": 1,
};

const read = async (name: string) => splitFrontMatter(await readFile(`eval/corpus/${name}`, "utf8"));

describe("eval/corpus", () => {
  it("holds exactly the 25 files listed", async () => {
    expect((await readdir("eval/corpus")).sort()).toEqual(Object.keys(CORPUS).sort());
  });

  it("each file has its title, its author (front matter, or its kind's default), and every required sentence verbatim", async () => {
    for (const [name, spec] of Object.entries(CORPUS)) {
      const { author, body } = await read(name);
      const effective = author ?? defaultAuthor(kindFromFilename(name));
      expect([name, effective]).toEqual([name, spec.author]);
      expect([name, body.split("\n")[0]]).toEqual([name, `# ${spec.title}`]);
      const text = normalizeWhitespace(body);
      for (const r of spec.required ?? []) expect([name, r, text.includes(normalizeWhitespace(r))]).toEqual([name, r, true]);
      for (const f of spec.forbidden ?? []) expect([name, f, text.includes(f)]).toEqual([name, f, false]);
    }
  });

  it("names the shared people and companies across files, so graph questions have something to traverse", async () => {
    const texts = await Promise.all(Object.keys(CORPUS).map(async (n) => (await read(n)).body));
    for (const [entity, min] of Object.entries(SHARED)) {
      expect([entity, texts.filter((t) => t.includes(entity)).length >= min]).toEqual([entity, true]);
    }
  });

  it("answers none of the negative questions: no Kyoto dinner, no result of the Acme SQL screen", async () => {
    for (const name of Object.keys(CORPUS)) {
      const { body } = await read(name);
      expect([name, /kyoto|sushi/i.test(body)]).toEqual([name, false]);
      expect([name, /SQL screen[^.]*\b(passed|failed|score|scored|result)/i.test(body)]).toEqual([name, false]);
    }
  });

  it("keeps the new files short: 60 to 400 words each", async () => {
    for (const [name, spec] of Object.entries(CORPUS)) {
      if (!spec.required) continue;
      const words = (await read(name)).body.split(/\s+/).filter(Boolean).length;
      expect([name, words >= 60 && words <= 400]).toEqual([name, true]);
    }
  });
});
