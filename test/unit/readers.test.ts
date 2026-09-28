import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readInput, htmlToRead, markdownTitle, fetchWithTimeout } from "../../src/ingest/readers.js";

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

function minimalPdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

async function listen(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function shutdown(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

describe("readers follow-up fixes", () => {
  it("skips an unreadable file in a directory walk and keeps the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-read-"));
    try {
      await writeFile(join(dir, "good.md"), "# Good\nbody\n");
      await writeFile(join(dir, "corrupt.pdf"), "this is not a pdf at all \x00\x01\x02");
      const results = await readInput(dir);
      expect(results.map((r) => r.origin)).toEqual([join(dir, "good.md")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("follows symlinks to files and survives a symlink loop", async () => {
    const root = await mkdtemp(join(tmpdir(), "brain-link-"));
    try {
      const dir = join(root, "dir");
      await mkdir(dir);
      await writeFile(join(root, "outside.md"), "# Outside\nlinked\n");
      await symlink(join(root, "outside.md"), join(dir, "linked.md"));
      await symlink(dir, join(dir, "loop"));
      const results = await readInput(dir);
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe("Outside");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("extracts text from a PDF fetched by URL", async () => {
    const pdf = minimalPdf("Hello PDF World");
    const { server, base } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(pdf);
    });
    try {
      const [r] = await readInput(`${base}/docs/report.pdf`);
      expect(r.text.startsWith("%PDF")).toBe(false);
      expect(r.text).toContain("Hello PDF World");
      expect(r.mimeType).toBe("application/pdf");
      expect(r.title).toBe("report");
    } finally {
      await shutdown(server);
    }
  });

  it("times out a fetch whose server never responds", async () => {
    const { server, base } = await listen(() => {
      /* never respond */
    });
    try {
      await expect(fetchWithTimeout(base, 200)).rejects.toThrow();
    } finally {
      await shutdown(server);
    }
  }, 5_000);

  it("decodes entities in the HTML title", () => {
    expect(htmlToRead("<title>Acme &amp; Co</title><p>x</p>", "u").title).toBe("Acme & Co");
  });
});
