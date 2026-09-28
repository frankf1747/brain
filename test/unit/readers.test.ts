import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readInput, htmlToRead, markdownTitle } from "../../src/ingest/readers.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, "..", "fixtures");

describe("readers", () => {
  it("reads a markdown file and takes the H1 as title", async () => {
    const [r] = await readInput(join(fixtures, "sample.md"));
    expect(r.title).toBe("Sample Note");
    expect(r.mimeType).toBe("text/markdown");
    expect(r.text).toContain("twelve engineers");
    expect(r.origin).toBe(join(fixtures, "sample.md"));
  });

  it("converts HTML to text, keeps the title, drops nav, script and style", () => {
    const html = `<html><head><title>T</title><style>x{}</style></head><body><nav>menu</nav><p>Hello <a href="u">there</a></p><script>bad()</script></body></html>`;
    const r = htmlToRead(html, "https://x.test/p");
    expect(r.title).toBe("T");
    expect(r.text).toContain("Hello there");
    expect(r.text).not.toContain("menu");
    expect(r.text).not.toContain("bad()");
    expect(r.text).not.toContain("x{}");
  });

  it("reads an HTML file", async () => {
    const [r] = await readInput(join(fixtures, "sample.html"));
    expect(r.title).toBe("Acme Raises Series B");
    expect(r.text).toContain("Beta Ventures");
  });

  it("walks a directory recursively and skips unsupported files", async () => {
    const results = await readInput(fixtures);
    const origins = results.map((r) => r.origin.replace(fixtures, ""));
    expect(origins).toEqual(expect.arrayContaining(["/sample.md", "/sample.html", "/nested/deep.txt"]));
  });

  it("finds a markdown title only from a level-1 heading", () => {
    expect(markdownTitle("## Not it\n# Yes\n")).toBe("Yes");
    expect(markdownTitle("no headings")).toBeNull();
  });
});
