import { z } from "zod";

export const GOLDEN_KINDS = ["keyword", "semantic", "graph", "filter", "fallback", "attribution", "negative"] as const;
export type GoldenKind = (typeof GOLDEN_KINDS)[number];

const ExpectedSchema = z.object({
  /** Suffix of documents.origin, e.g. the fixture file name. */
  origin: z.string().min(1).optional(),
  /** A document id, for items captured from the real base. */
  document_id: z.string().uuid().optional(),
  /** Verbatim span from the document; when present, a passage is relevant only if it contains it. */
  quote: z.string().min(1).optional(),
}).strict().refine((e) => e.origin || e.document_id, { message: "expected needs origin or document_id" });

export const GoldenItemSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(GOLDEN_KINDS),
  expected: z.array(ExpectedSchema),
  filters: z.object({ sourceKinds: z.array(z.string()).optional() }).strict().optional(),
  paraphrases: z.array(z.string().min(1)).optional(),
  source: z.enum(["fixture", "generated", "captured"]),
  negative: z.boolean().default(false),
  approved_at: z.string().min(1),
}).strict();
export type GoldenItem = z.infer<typeof GoldenItemSchema>;
export type Expected = z.infer<typeof ExpectedSchema>;

/**
 * One JSON object per line; blank lines are ignored. Unknown keys are rejected. Throws with the line number
 * (and the field path for schema errors) on the first invalid line.
 */
export function parseGolden(text: string): GoldenItem[] {
  const items: GoldenItem[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (err) {
      throw new Error(`golden line ${i + 1}: invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    const parsed = GoldenItemSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((x) => (x.path.length ? `${x.path.join(".")}: ${x.message}` : x.message));
      throw new Error(`golden line ${i + 1}: ${issues.join("; ")}`);
    }
    const item = parsed.data;
    const at = `golden line ${i + 1} (${item.id})`;
    if (seen.has(item.id)) throw new Error(`golden line ${i + 1}: duplicate id ${item.id}`);
    seen.add(item.id);
    if ((item.kind === "negative") !== item.negative) throw new Error(`${at}: kind "negative" and negative: true must go together`);
    if (item.negative && item.expected.length > 0) throw new Error(`${at}: a negative item must not list expected documents`);
    if (!item.negative && item.expected.length === 0) throw new Error(`${at}: expected is empty; mark the item negative or list a document`);
    items.push(item);
  }
  return items;
}
