import { describe, it, expect } from "vitest";
import { formatUsage, voyageTodayLine, type UsageRow } from "../../src/llm/usage.js";

const rows: UsageRow[] = [
  { day: "2026-10-02", operation: "embed_document", requests: 3, tokens: 1_300, refused: 0, errors: 1, stale: 0 },
  { day: "2026-10-02", operation: "rerank", requests: 2, tokens: 24_000, refused: 4, errors: 0, stale: 1 },
  { day: "2026-10-01", operation: "embed_query", requests: 5, tokens: 50, refused: 0, errors: 0, stale: 0 },
];

describe("voyageTodayLine", () => {
  it("shows today's tokens against the cap", () => {
    expect(voyageTodayLine(1_250_000, 5_000_000)).toBe("Voyage today: 1,250,000 of 5,000,000 tokens (25.0%)");
    expect(voyageTodayLine(0, 5_000_000)).toBe("Voyage today: 0 of 5,000,000 tokens (0.0%)");
  });
  it("says a cap of 0 blocks every call", () => {
    expect(voyageTodayLine(0, 0)).toBe("Voyage today: 0 of 0 tokens (the cap is 0: every Voyage call is blocked)");
  });
});

describe("formatUsage", () => {
  it("prints a line per day and operation, a day total, refusals, stale reservations, and today against the cap", () => {
    const lines = formatUsage(rows, { days: 30, tokensToday: 25_300, cap: 5_000_000, prices: { embed: 0, rerank: 0 } });
    expect(lines[0]).toMatch(/^UTC day\s+operation\s+requests\s+tokens\s+refused\s+errors$/);
    expect(lines[1]).toMatch(/^2026-10-02\s+embed_document\s+3\s+1,300\s+0\s+1$/);
    expect(lines[2]).toMatch(/^2026-10-02\s+rerank\s+2\s+24,000\s+4\s+0\s+\(1 stale reservation counted at the estimate\)$/);
    expect(lines[3]).toMatch(/^2026-10-02\s+all\s+5\s+25,300\s+4\s+1\s+\(1 stale reservation counted at the estimate\)$/);
    expect(lines[4]).toMatch(/^2026-10-01\s+embed_query\s+5\s+50\s+0\s+0$/);
    expect(lines).toContain("Set BRAIN_VOYAGE_PRICE_PER_MTOK_EMBED and BRAIN_VOYAGE_PRICE_PER_MTOK_RERANK in .env to see an estimated cost.");
    expect(lines.at(-1)).toBe("Voyage today: 25,300 of 5,000,000 tokens (0.5%); the count resets at 00:00 UTC.");
  });

  it("adds an estimated cost column when a price is set (illustrative prices)", () => {
    const priced: UsageRow[] = [
      { day: "2026-10-02", operation: "embed_document", requests: 10, tokens: 2_000_000, refused: 0, errors: 0, stale: 0 },
      { day: "2026-10-02", operation: "rerank", requests: 4, tokens: 500_000, refused: 0, errors: 0, stale: 0 },
    ];
    const lines = formatUsage(priced, { days: 1, tokensToday: 2_500_000, cap: 5_000_000, prices: { embed: 0.12, rerank: 0.05 } });
    expect(lines[0]).toMatch(/errors\s+est\. cost$/);
    expect(lines[1]).toMatch(/^2026-10-02\s+embed_document\s+10\s+2,000,000\s+0\s+0\s+\$0\.2400$/);
    expect(lines[2]).toMatch(/^2026-10-02\s+rerank\s+4\s+500,000\s+0\s+0\s+\$0\.0250$/);
    expect(lines[3]).toMatch(/^2026-10-02\s+all\s+14\s+2,500,000\s+0\s+0\s+\$0\.2650$/);
    expect(lines.join("\n")).not.toContain("to see an estimated cost");
  });

  it("says when there were no calls", () => {
    const lines = formatUsage([], { days: 7, tokensToday: 0, cap: 0, prices: { embed: 0, rerank: 0 } });
    expect(lines[0]).toBe("No Voyage calls in the last 7 UTC days.");
    expect(lines.at(-1)).toBe("Voyage today: 0 of 0 tokens (the cap is 0: every Voyage call is blocked); the count resets at 00:00 UTC.");
  });
});
