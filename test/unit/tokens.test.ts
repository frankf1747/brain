import { describe, it, expect } from "vitest";
import { parseTokens, matchToken } from "../../src/mcp/http.js";

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
