import { config } from "../config.js";
import { canonicalName } from "../text/normalize.js";

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
}

export class VoyageClient implements Embedder, Reranker {
  constructor(private readonly opts: VoyageOptions = {}) {}

  private get apiKey(): string {
    const key = this.opts.apiKey ?? config.voyageApiKey;
    if (!key) throw new Error("VOYAGE_API_KEY is not set");
    return key;
  }

  async embed(texts: string[], inputType: InputType): Promise<number[][]> {
    const out: number[][] = [];
    const size = this.opts.batchSize ?? 128;
    for (let i = 0; i < texts.length; i += size) {
      const batch = texts.slice(i, i + size);
      const body = await this.post("/embeddings", {
        input: batch,
        model: this.opts.embedModel ?? config.voyageEmbedModel,
        input_type: inputType,
        output_dimension: config.embeddingDimensions,
      });
      const data = (body.data as { index: number; embedding: number[] }[]).slice().sort((a, b) => a.index - b.index);
      if (data.length !== batch.length) throw new Error(`Voyage returned ${data.length} embeddings for ${batch.length} inputs`);
      out.push(...data.map((d) => d.embedding));
    }
    return out;
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    if (documents.length === 0) return [];
    const body = await this.post("/rerank", {
      query,
      documents,
      model: this.opts.rerankModel ?? config.voyageRerankModel,
      top_k: Math.min(topK, documents.length),
    });
    return (body.data as { index: number; relevance_score: number }[]).map((d) => ({ index: d.index, score: d.relevance_score }));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async post(path: string, payload: unknown): Promise<any> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const delay = this.opts.retryDelayMs ?? 500;
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 4; attempt++) {
      const init = {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
      };
      let res: Response;
      try {
        res = await fetchFn(`${BASE}${path}`, init);
      } catch (err) {
        // Network failure (DNS, reset, "fetch failed"): retry with backoff like a 5xx.
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise((r) => setTimeout(r, delay * 2 ** attempt));
        continue;
      }
      if (res.ok) return res.json();
      const text = await res.text();
      lastError = new Error(`Voyage ${path} returned ${res.status}: ${text.slice(0, 200)}`);
      if (res.status !== 429 && res.status < 500) throw lastError;
      await new Promise((r) => setTimeout(r, delay * 2 ** attempt));
    }
    throw lastError;
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
