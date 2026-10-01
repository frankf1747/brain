import { describe, it, expect } from "vitest";
import { AUTHORS, isAuthor, parseAuthor, defaultAuthor } from "../../src/ingest/author.js";

describe("author values", () => {
  it("are owner, other and unknown", () => {
    expect(AUTHORS).toEqual(["owner", "other", "unknown"]);
    expect(isAuthor("other")).toBe(true);
    expect(isAuthor("me")).toBe(false);
    expect(isAuthor(undefined)).toBe(false);
  });
  it("parse user input case-insensitively and reject anything else", () => {
    expect(parseAuthor(" Other ")).toBe("other");
    expect(() => parseAuthor("me")).toThrow('author must be one of owner, other, unknown; got "me"');
  });
});

describe("defaultAuthor", () => {
  it("maps source kinds through config.authorDefaults and everything else to unknown", () => {
    expect(defaultAuthor("note")).toBe("owner");
    expect(defaultAuthor("paste")).toBe("owner");
    expect(defaultAuthor("email")).toBe("other");
    expect(defaultAuthor("podcast")).toBe("unknown");
    expect(defaultAuthor("constructor")).toBe("unknown"); // not fooled by Object.prototype
  });
});
