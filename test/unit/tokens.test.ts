import { describe, it, expect } from "vitest";
import { parseTokens, matchToken, weakTokenClients, MIN_TOKEN_LENGTH } from "../../src/mcp/http.js";

describe("parseTokens", () => {
  it("maps token to client name and ignores malformed entries", () => {
    const m = parseTokens("claude-desktop:abc, chatgpt:def ,broken,:noname,nokey:");
    expect(m.get("abc")).toBe("claude-desktop");
    expect(m.get("def")).toBe("chatgpt");
    expect(m.size).toBe(2);
    expect(parseTokens(undefined).size).toBe(0);
  });
});

describe("matchToken", () => {
  const tokens = parseTokens("tester:secret123,other:zzz");

  it("returns the client name for an exact token", () => {
    expect(matchToken(tokens, "secret123")).toBe("tester");
    expect(matchToken(tokens, "zzz")).toBe("other");
  });

  it("rejects a token differing only in the last character", () => {
    expect(matchToken(tokens, "secret124")).toBeUndefined();
  });

  it("rejects prefixes, extensions and the empty string", () => {
    expect(matchToken(tokens, "secret12")).toBeUndefined();
    expect(matchToken(tokens, "secret1234")).toBeUndefined();
    expect(matchToken(tokens, "")).toBeUndefined();
  });
});

describe("weakTokenClients", () => {
  it("names clients whose token is shorter than the minimum", () => {
    const strong = "a".repeat(MIN_TOKEN_LENGTH);
    expect(MIN_TOKEN_LENGTH).toBeGreaterThanOrEqual(32);
    expect(weakTokenClients(parseTokens(`ok:${strong},weak:abc`))).toEqual(["weak"]);
    expect(weakTokenClients(parseTokens(`ok:${strong}`))).toEqual([]);
  });
});
