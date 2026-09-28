import { readFile, readdir, realpath, stat } from "node:fs/promises";
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
  const rawTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const title = rawTitle === undefined ? null : convert(rawTitle, { wordwrap: false }).trim() || null;
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

async function pdfToRead(bytes: Uint8Array, origin: string, title: string | null): Promise<ReadResult> {
  const pdf = await getDocumentProxy(bytes);
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((p) => p.trim()).filter(Boolean);
  return {
    text: pages.join("\n\n"),
    title,
    mimeType: "application/pdf",
    origin,
    metadata: { pages: totalPages },
  };
}

async function readPdf(path: string): Promise<ReadResult> {
  const buf = await readFile(path);
  return pdfToRead(new Uint8Array(buf), path, basename(path, extname(path)));
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

function skip(path: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`brain: skipping ${path}: ${message}\n`);
}

/** Recurses through a directory. Unreadable files are reported on stderr and skipped; symlinks are followed with cycle protection. */
async function readDirectory(dir: string, visited: Set<string> = new Set()): Promise<ReadResult[]> {
  visited.add(await realpath(dir));
  const out: ReadResult[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    let isDir = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const st = await stat(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch (err) {
        skip(full, err);
        continue;
      }
    }
    if (isDir) {
      if (entry.name === "node_modules") continue;
      let real: string;
      try {
        real = await realpath(full);
      } catch (err) {
        skip(full, err);
        continue;
      }
      if (visited.has(real)) continue;
      out.push(...(await readDirectory(full, visited)));
    } else if (isFile && isSupportedFile(full)) {
      try {
        out.push(await readOneFile(full));
      } catch (err) {
        skip(full, err);
      }
    }
  }
  return out;
}

export const FETCH_TIMEOUT_MS = 30_000;

export async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  return fetch(url, { headers: { "user-agent": "brain-kb/0.1" }, signal: AbortSignal.timeout(ms) });
}

function urlTitle(url: string): string | null {
  const last = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!last) return null;
  return basename(decodeURIComponent(last), extname(last)) || null;
}

async function readUrl(url: string): Promise<ReadResult> {
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`GET ${url} failed with ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (type.includes("pdf") || new URL(url).pathname.toLowerCase().endsWith(".pdf")) {
    return pdfToRead(new Uint8Array(await res.arrayBuffer()), url, urlTitle(url));
  }
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
