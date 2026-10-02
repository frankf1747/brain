import { config } from "../config.js";
import { canonicalName } from "../text/normalize.js";
import { reserveTokens, settleReservation, type MeteredCall, type Settlement, type VoyageLedger } from "./ledger.js";

export type InputType = "query" | "document";

export interface Embedder {
  embed(texts: string[], inputType: InputType): Promise<number[][]>;
}

export interface RerankHit {
  index: number;
  score: number;
}

export interface Reranker {
  rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]>;
}

const BASE = "https://api.voyageai.com/v1";

export interface VoyageOptions {
  apiKey?: string;
  embedModel?: string;
  rerankModel?: string;
  fetchFn?: typeof fetch;
  batchSize?: number;
  retryDelayMs?: number;
  /** Base wait after a 429 without Retry-After; doubles per attempt, capped at 60 s. */
  rateLimitDelayMs?: number;
  /** Injected for tests; defaults to a setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Total calls allowed while Voyage answers 429 (default 6). 1 means fail on the first 429 without waiting. */
  maxRateLimitAttempts?: number;
  /** Total calls allowed across 5xx responses and network errors (default 4). */
  maxAttempts?: number;
  /**
   * Milliseconds one HTTP attempt may take before it is aborted (AbortSignal.timeout; default 120 s, query clients
   * 30 s). A timed-out attempt is a thrown fetch: retried like a network error and counted at its estimate.
   */
  requestTimeoutMs?: number;
  /** Most total time one call may sleep between attempts; a wait that would pass it gives up instead (default unlimited). */
  maxTotalWaitMs?: number;
  /**
   * The spend ledger and its daily cap (src/llm/ledger.ts). Every HTTP attempt is reserved before it is sent and
   * settled after. Required unless fetchFn is injected (tests): a client that could reach Voyage unmetered is
   * refused at construction.
   */
  ledger?: VoyageLedger;
}

const MAX_ATTEMPTS = 4;
const MAX_RATE_LIMIT_ATTEMPTS = 6;
const MAX_RATE_LIMIT_WAIT_MS = 60_000;
/** Ingest requests carry up to 128 chunks, so they get a generous timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
/** Query-time clients (src/ctx.ts): a single query or one rerank should never take 30 s. */
export const QUERY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Query-time clients (src/ctx.ts): 3 attempts and at most 10 s of backoff in total, so a search degrades quickly
 * instead of waiting out a Voyage outage. With a paid tier that is enough; without one the search still fails fast.
 */
export const QUERY_RETRY_BUDGET = {
  maxAttempts: 3,
  maxRateLimitAttempts: 3,
  retryDelayMs: 500,
  rateLimitDelayMs: 2_000,
  maxTotalWaitMs: 10_000,
} as const;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Parses a Retry-After header (delta seconds or an HTTP date) into milliseconds, or undefined. */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - Date.now());
}

/** Tokens an embeddings request is reserved at: 4 characters per token, at least 1. */
export function estimateEmbedTokens(texts: string[]): number {
  const chars = texts.reduce((s, t) => s + t.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** Tokens a rerank request is reserved at: Voyage counts the query once per document plus every document. */
export function estimateRerankTokens(query: string, documents: string[]): number {
  const chars = query.length * documents.length + documents.reduce((s, d) => s + d.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

/** usage.total_tokens from an embeddings or rerank response, or null when it is missing or malformed. */
export function usageTokens(body: unknown): number | null {
  const t = (body as { usage?: { total_tokens?: unknown } } | null)?.usage?.total_tokens;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 ? Math.round(t) : null;
}

export class VoyageClient implements Embedder, Reranker {
  constructor(private readonly opts: VoyageOptions = {}) {
    // Fail closed: only a test that injects fetchFn may run without the ledger and its daily cap.
    if (!opts.ledger && !opts.fetchFn) {
      throw new Error("VoyageClient needs a spend ledger ({ sql, client }) so every call counts against BRAIN_VOYAGE_DAILY_TOKEN_CAP");
    }
  }

  /** The ledger this client records and caps its calls in, or null for an unmetered test client. */
  get ledger(): VoyageLedger | null {
    return this.opts.ledger ?? null;
  }

  /** How long one HTTP attempt may take before it is aborted. */
  get requestTimeoutMs(): number {
    return this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /** The attempt and wait limits this client applies to one call. */
  get retryBudget(): { maxAttempts: number; maxRateLimitAttempts: number; maxTotalWaitMs: number } {
    return {
      maxAttempts: this.opts.maxAttempts ?? MAX_ATTEMPTS,
      maxRateLimitAttempts: this.opts.maxRateLimitAttempts ?? MAX_RATE_LIMIT_ATTEMPTS,
      maxTotalWaitMs: this.opts.maxTotalWaitMs ?? Infinity,
    };
  }

  private get apiKey(): string {
    const key = this.opts.apiKey ?? config.voyageApiKey;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");
    return key;
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.opts.batchSize ?? 128;
    const model = this.opts.embedModel ?? config.voyageEmbedModel;
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const body = await this.post(
        "/embeddings",
        { input: batch, model, input_type: inputType, output_dimension: config.embeddingDimensions },
        { operation: inputType === "query" ? "embed_query" : "embed_document", model, estimatedTokens: estimateEmbedTokens(batch) },
      );
      const data = (body.data as { index: number; embedding: number[] }[]).slice().sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
      out.push(...data.map((d) => d.embedding));
    }
    return out;
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    if (documents.length === 0) return [];
    const model = this.opts.rerankModel ?? config.voyageRerankModel;
    const body = await this.post(
      "/rerank",
      { query, documents, model, top_k: Math.min(topK, documents.length) },
      { operation: "rerank", model, estimatedTokens: estimateRerankTokens(query, documents) },
    );
    return (body.data as { index: number; relevance_score: number }[]).map((d) => ({ index: d.index, score: d.relevance_score }));
  }

  /** Reserves one attempt; throws SpendCapError when the cap refuses it. Null when unmetered (tests). */
  private async reserve(call: MeteredCall): Promise<string | null> {
    return this.opts.ledger ? reserveTokens(this.opts.ledger, call) : null;
  }

  /** A settle that fails leaves the row reserved, where it keeps counting at its estimate: the safe side. */
  private async settle(id: string | null, outcome: Settlement): Promise<void> {
    if (id === null || !this.opts.ledger) return;
    try {
      await settleReservation(this.opts.ledger.sql, id, outcome);
    } catch (err) {
      process.stderr.write(`brain: recording Voyage usage failed (row ${id} keeps counting at its estimate): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async post(path: string, payload: unknown, call: MeteredCall): Promise<any> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleep ?? defaultSleep;
    const delay = this.opts.retryDelayMs ?? 500;
    const rateDelay = this.opts.rateLimitDelayMs ?? 20_000;
    const { maxAttempts, maxRateLimitAttempts, maxTotalWaitMs } = this.retryBudget;
    let waited = 0;
    /** Sleeps unless that would pass the total wait budget; false means give up now. */
    const pause = async (ms: number): Promise<boolean> => {
      if (waited + ms > maxTotalWaitMs) return false;
      waited += ms;
      await sleep(ms);
      return true;
    };
    // Read before any reservation, so a missing key never leaves a reserved row behind.
    const authorization = `Bearer ${this.apiKey}`;
    let lastError: Error | undefined;
    // 429s and other transient failures have separate budgets: rate limits need minute-scale waits.
    let failures = 0;
    let rateLimits = 0;
    for (;;) {
      // Each attempt is its own reservation: a retry re-checks the cap. A 429 or 5xx settles at 0 tokens (Voyage
      // does not bill them); a thrown fetch keeps counting at its estimate.
      const reservation = await this.reserve(call);
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      };
      let res: Response;
      try {
        res = await fetchFn(`${BASE}${path}`, init);
      } catch (err) {
        // Network failure (DNS, reset, "fetch failed") or our timeout: retry with backoff like a 5xx. Voyage may
        // already have processed and billed the request (a timeout waiting for headers, a connection dropped
        // after processing), so the attempt keeps counting at its estimate.
        lastError = err instanceof Error ? err : new Error(String(err));
        await this.settle(reservation, { error: lastError.message, maybeBilled: true });
        if (++failures >= maxAttempts) throw lastError;
        if (!(await pause(delay * 2 ** (failures - 1)))) throw lastError;
        continue;
      }
      if (res.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let body: any;
        try {
          body = await res.json();
        } catch (err) {
          // Voyage answered 200, so the call is billed: keep the row at its estimate.
          await this.settle(reservation, { tokens: null, error: `unreadable response: ${err instanceof Error ? err.message : String(err)}` });
          throw err;
        }
        const tokens = usageTokens(body);
        if (tokens === null && reservation !== null) {
          process.stderr.write(`brain: Voyage ${path} response had no usage.total_tokens; recorded at the estimate\n`);
        }
        await this.settle(reservation, { tokens });
        return body;
      }
      // The body can fail to arrive (timeout, reset); the status is what matters here.
      const text = await res.text().catch(() => "");
      lastError = new Error(`Voyage ${path} returned ${res.status}: ${text.slice(0, 200)}`);
      await this.settle(reservation, { error: lastError.message });
      if (res.status === 429) {
        if (++rateLimits >= maxRateLimitAttempts) throw lastError;
        const wait = Math.min(
          retryAfterMs(res.headers.get("retry-after")) ?? rateDelay * 2 ** (rateLimits - 1),
          MAX_RATE_LIMIT_WAIT_MS,
        );
        if (waited + wait > maxTotalWaitMs) throw lastError;
        process.stderr.write(`brain: Voyage rate limited, waiting ${Math.ceil(wait / 1000)}s\n`);
        await pause(wait);
        continue;
      }
      if (res.status < 500) throw lastError;
      if (++failures >= maxAttempts) throw lastError;
      if (!(await pause(delay * 2 ** (failures - 1)))) throw lastError;
    }
  }
}

/** Deterministic pseudo-embedding keyed on the canonical form of the text. Equal names collide, unrelated names do not. */
export function hashVector(text: string, dims = config.embeddingDimensions): number[] {
  const key = canonicalName(text);
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let x = h || 1;
  const v = new Array<number>(dims);
  for (let i = 0; i < dims; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    v[i] = x / 4294967296 - 0.5;
  }
  const n = Math.sqrt(v.reduce((s, a) => s + a * a, 0));
  return v.map((a) => a / n);
}

export class FakeEmbedder implements Embedder {
  calls: string[][] = [];
  async embed(texts: string[], _inputType?: InputType): Promise<number[][]> {
    this.calls.push(texts);
    return texts.map((t) => hashVector(t));
  }
}

export class FakeReranker implements Reranker {
  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    const words = new Set(query.toLowerCase().split(/\W+/).filter(Boolean));
    return documents
      .map((d, index) => ({
        index,
        score: d.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length / (words.size || 1),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
