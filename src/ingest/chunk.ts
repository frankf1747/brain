import { config } from "../config.js";
import { estimateTokens } from "../text/normalize.js";

export interface ChunkOptions {
  sectionTokens: number;
  passageTokens: number;
  overlapRatio: number;
}

export interface ChunkDraft {
  level: 0 | 1;
  /** Position among chunks of the same level within the document. */
  ordinal: number;
  /** For level 1, the ordinal of its level 0 section. */
  parentOrdinal: number | null;
  headingPath: string[];
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

export interface Span {
  start: number;
  end: number;
}

export interface Block extends Span {
  headingPath: string[];
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function hasText(text: string, span: Span): boolean {
  return text.slice(span.start, span.end).trim().length > 0;
}

/** Split on markdown headings, keeping the heading stack as a path. */
export function headingBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const stack: { level: number; title: string }[] = [];
  let cur: Block = { headingPath: [], start: 0, end: 0 };
  let pos = 0;
  for (const line of text.split("\n")) {
    const lineStart = pos;
    pos += line.length + 1;
    const m = HEADING.exec(line);
    if (!m) continue;
    cur.end = lineStart;
    if (hasText(text, cur)) blocks.push(cur);
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title: m[2] });
    cur = { headingPath: stack.map((h) => h.title), start: Math.min(pos, text.length), end: 0 };
  }
  cur.end = text.length;
  if (hasText(text, cur)) blocks.push(cur);
  return blocks;
}

function trimSpan(text: string, s: Span): Span | null {
  let a = s.start;
  let b = s.end;
  while (a < b && /\s/.test(text[a])) a++;
  while (b > a && /\s/.test(text[b - 1])) b--;
  return a < b ? { start: a, end: b } : null;
}

/** Sentence-level spans inside a block; paragraphs never merge into one unit. */
export function sentenceSpans(text: string, block: Span): Span[] {
  const out: Span[] = [];
  const slice = text.slice(block.start, block.end);
  const paragraph = /(?:[^\n]|\n(?!\s*\n))+/g;
  const sentence = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;
  for (const p of slice.matchAll(paragraph)) {
    const pStart = block.start + p.index!;
    let found = 0;
    for (const s of p[0].matchAll(sentence)) {
      const span = trimSpan(text, { start: pStart + s.index!, end: pStart + s.index! + s[0].length });
      if (span) {
        out.push(span);
        found++;
      }
    }
    if (found === 0) {
      const whole = trimSpan(text, { start: pStart, end: pStart + p[0].length });
      if (whole) out.push(whole);
    }
  }
  return out;
}

/** Greedy packing of units into windows of at most maxTokens, with unit-aligned overlap. */
export function pack(text: string, units: Span[], maxTokens: number, overlapTokens: number): Span[] {
  const est = (u: Span) => estimateTokens(text.slice(u.start, u.end));
  const out: Span[] = [];
  let i = 0;
  while (i < units.length) {
    let j = i;
    let tokens = 0;
    while (j < units.length && tokens + est(units[j]) <= maxTokens) {
      tokens += est(units[j]);
      j++;
    }
    if (j === i) {
      const u = units[i];
      const step = maxTokens * 4;
      for (let s = u.start; s < u.end; s += step) out.push({ start: s, end: Math.min(s + step, u.end) });
      i++;
      continue;
    }
    out.push({ start: units[i].start, end: units[j - 1].end });
    if (j >= units.length) break;
    let back = j;
    let overlap = 0;
    while (back - 1 > i && overlap + est(units[back - 1]) <= overlapTokens) {
      overlap += est(units[back - 1]);
      back--;
    }
    i = back;
  }
  return out;
}

export function chunkDocument(text: string, opts: ChunkOptions = config.chunking): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  let sectionOrdinal = 0;
  let passageOrdinal = 0;
  const overlapTokens = Math.round(opts.passageTokens * opts.overlapRatio);

  const draft = (level: 0 | 1, ordinal: number, parentOrdinal: number | null, headingPath: string[], span: Span): ChunkDraft => {
    const content = text.slice(span.start, span.end);
    return { level, ordinal, parentOrdinal, headingPath, content, charStart: span.start, charEnd: span.end, tokenCount: estimateTokens(content) };
  };

  for (const block of headingBlocks(text)) {
    const units = sentenceSpans(text, block);
    for (const section of pack(text, units, opts.sectionTokens, 0)) {
      const inside = units.filter((u) => u.start >= section.start && u.end <= section.end);
      const passageUnits = inside.length ? inside : [section];
      drafts.push(draft(0, sectionOrdinal, null, block.headingPath, section));
      for (const p of pack(text, passageUnits, opts.passageTokens, overlapTokens)) {
        drafts.push(draft(1, passageOrdinal++, sectionOrdinal, block.headingPath, p));
      }
      sectionOrdinal++;
    }
  }
  return drafts;
}
