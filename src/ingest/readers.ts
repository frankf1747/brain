import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { convert } from "html-to-text";
import { extractText, getDocumentProxy } from "unpdf";

export interface ReadResult {
  text: string;
  title: string | null;
  mimeType: string;
  origin: string;
  metadata: Record<string, unknown>;
}

const TEXT_TYPES: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
};
const HTML_EXT = new Set([".html", ".htm"]);

export function markdownTitle(text: string): string | null {
  const m = /^#\s+(.+?)\s*$/m.exec(text);
  return m ? m[1] : null;
}

export function htmlToRead(html: string, origin: string): ReadResult {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const text = convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      { selector: "nav", format: "skip" },
      { selector: "script", format: "skip" },
      { selector: "style", format: "skip" },
    ],
  });
  return { text: text.trim(), title, mimeType: "text/html", origin, metadata: {} };
}

async function readPdf(path: string): Promise<ReadResult> {
  const buf = await readFile(path);
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((p) => p.trim()).filter(Boolean);
  return {
    text: pages.join("\n\n"),
    title: basename(path, extname(path)),
    mimeType: "application/pdf",
    origin: path,
    metadata: { pages: totalPages },
  };
}

async function readOneFile(path: string): Promise<ReadResult> {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return readPdf(path);
  if (HTML_EXT.has(ext)) return htmlToRead(await readFile(path, "utf8"), path);
  const mime = TEXT_TYPES[ext];
  if (!mime) throw new Error(`Unsupported file type: ${path}`);
  const text = await readFile(path, "utf8");
  const title = mime === "text/markdown" ? markdownTitle(text) : null;
  return { text, title: title ?? basename(path, ext), mimeType: mime, origin: path, metadata: {} };
}

export function isSupportedFile(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return ext === ".pdf" || HTML_EXT.has(ext) || ext in TEXT_TYPES;
}

async function readDirectory(dir: string): Promise<ReadResult[]> {
  const out: ReadResult[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await readDirectory(full)));
    else if (entry.isFile() && isSupportedFile(full)) out.push(await readOneFile(full));
  }
  return out;
}

async function readUrl(url: string): Promise<ReadResult> {
  const res = await fetch(url, { headers: { "user-agent": "brain-kb/0.1" } });
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  if (type.includes("html")) return htmlToRead(body, url);
  return { text: body, title: null, mimeType: type.split(";")[0] || "text/plain", origin: url, metadata: {} };
}

async function readStdin(): Promise<ReadResult> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return { text: Buffer.concat(chunks).toString("utf8"), title: null, mimeType: "text/plain", origin: "stdin", metadata: {} };
}

/** `-` reads stdin; http(s) fetches; a directory recurses; a file is read by extension. */
export async function readInput(input: string): Promise<ReadResult[]> {
  if (input === "-") return [await readStdin()];
  if (/^https?:\/\//i.test(input)) return [await readUrl(input)];
  const st = await stat(input);
  if (st.isDirectory()) return readDirectory(input);
  return [await readOneFile(input)];
}
