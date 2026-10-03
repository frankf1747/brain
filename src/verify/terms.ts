import type { Db } from "../db.js";

/**
 * Term extraction for the citation verifier (spec §7.2). Three kinds of evidence are read from a claim and from the
 * text it cites:
 *  - content terms: Postgres `to_tsvector('english', …)` lexemes, so stemming and stopwords are exactly the keyword
 *    index's (stemAll, one round trip for a whole verification);
 *  - numbers, dates and codes, normalised in TypeScript to one canonical spelling each (extractNumbers);
 *  - negation words, read from the raw text, because the english configuration drops most of them as stopwords
 *    (hasNegation).
 * Everything here except stemAll is pure.
 */

/** Lexemes per input string, as Postgres produced them; built by stemAll, or by hand in unit tests. */
export type StemMap = Map<string, string[]>;

/**
 * The lexemes of every distinct text, from Postgres, in one round trip: `select lexeme from unnest(to_tsvector(...))`.
 * Each text maps to its distinct lexemes in sorted order (an empty list for a text that is all stopwords).
 */
export async function stemAll(sql: Db, texts: string[]): Promise<StemMap> {
  const unique = [...new Set(texts)];
  const map: StemMap = new Map(unique.map((t) => [t, [] as string[]]));
  if (unique.length === 0) return map;
  const rows = await sql<{ i: number; lexeme: string }[]>`
    select t.i::int as i, v.lexeme
    from unnest(${unique}::text[]) with ordinality as t(s, i)
    cross join lateral unnest(to_tsvector('english', t.s)) as v
    order by t.i, v.lexeme`;
  for (const r of rows) map.get(unique[r.i - 1])!.push(r.lexeme);
  return map;
}

/** The lexemes of one text (stemAll for a single string). */
export async function stems(sql: Db, text: string): Promise<string[]> {
  return (await stemAll(sql, [text])).get(text)!;
}

/**
 * Negation lexemes that survive the english stopword list. They are checked by hasNegation, so they are not counted
 * as content terms (otherwise a negated claim would be penalised twice, and a negated source not at all).
 */
const NEGATION_LEXEMES = new Set(["never", "without", "none", "neither", "cannot"]);

/** A lexeme that counts as a content term: it has a letter (pure digits are numbers) and is not a negation word. */
export function isContentLexeme(lexeme: string): boolean {
  return /\p{L}/u.test(lexeme) && !NEGATION_LEXEMES.has(lexeme);
}

/** The negation words: not, no, never, without, none, neither, nor, cannot, and any word ending in n't (or n’t). */
export const NEGATION_WORDS = ["not", "no", "never", "without", "none", "neither", "nor", "cannot", "n't"] as const;
const NEGATION_RE = /(?<![\p{L}\p{N}])(?:not|no|never|without|none|neither|nor|cannot)(?![\p{L}\p{N}])|\p{L}n['’]t(?!\p{L})/iu;

/** True when the raw text contains a negation word (case-insensitive, whole words; n't as a word ending). */
export function hasNegation(text: string): boolean {
  return NEGATION_RE.test(text);
}

/**
 * Polarity words: direction, order, comparison, scope and modality. The english stopword list drops most of them
 * ("went up 11%" and "went down 11%" have the same lexemes), so they are read from the raw text, like negation, and
 * every one in a claim must appear in the cited text (polarityWords).
 */
export const POLARITY_WORDS = [
  "up", "down", "before", "after", "over", "under", "above", "below", "more", "most", "less", "fewer", "few", "all", "some",
  "only", "against", "will", "would", "might", "must", "can", "could", "should",
] as const;
const POLARITY_SET = new Set<string>(POLARITY_WORDS);
/** Negative contractions and cannot, read as their polarity word: won't is will, can't and cannot are can. */
const POLARITY_CONTRACTIONS: Record<string, string> = { wo: "will", ca: "can", would: "would", could: "could", should: "should", must: "must", might: "might" };

/** The polarity words in a raw text, lower-cased, as whole words (won't counts as will, cannot and can't as can). */
export function polarityWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\p{N}'’])(\p{L}+?)(?:n['’]t)?(?![\p{L}\p{N}])/gu)) {
    const whole = m[0].toLowerCase();
    const base = m[1].toLowerCase();
    if (/n['’]t$/.test(whole)) {
      const w = POLARITY_CONTRACTIONS[base];
      if (w) out.add(w);
    } else if (base === "cannot") out.add("can");
    else if (POLARITY_SET.has(base)) out.add(base);
  }
  return out;
}

/** Counting words: when one of them is a missing term, the claim states a count or rank the cited text does not. */
const NUMBER_WORDS = new Set([
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
  "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty",
  "ninety", "hundred", "hundreds", "thousand", "thousands", "million", "millions", "billion", "billions", "dozen", "dozens",
  "half", "twice", "once", "single", "couple", "pair", "several", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth",
  "twentieth", "thirtieth", "fortieth", "fiftieth", "sixtieth", "seventieth", "eightieth", "ninetieth", "hundredth",
  "thousandth", "millionth", "billionth",
]);

/** True for a number word or an ordinal word ("one", "first", "dozen", "tenth", "twenty-first"), in any case. */
export function isNumberWord(word: string): boolean {
  const parts = word.toLowerCase().split("-");
  return parts.length > 0 && parts.every((p) => NUMBER_WORDS.has(p));
}

/** won't, can't, shan't and ain't do not end in their base word plus n't. */
const CONTRACTION_BASE: Record<string, string> = { wo: "will", ca: "can", sha: "shall", ai: "is" };

export interface ClaimWord {
  /** The word as the user wrote it, without surrounding punctuation: what missingTerms shows. */
  display: string;
  /** What is stemmed: the word, with a negative contraction reduced to its base (doesn't → does, won't → will). */
  stemKey: string;
}

/**
 * Answer and connective words that state nothing a source could confirm. The english stopword list keeps them
 * ("Yes." has the lexeme yes), so claimWords skips them: "Yes [P1]." has no content terms.
 */
export const FILLER_WORDS = new Set([
  "yes", "yeah", "yep", "ok", "okay", "sure", "indeed", "also", "however", "therefore", "thus", "moreover", "furthermore",
  "additionally", "overall", "finally",
]);

/**
 * A claim's words, split on whitespace, in order, without FILLER_WORDS. Postgres never joins tokens across
 * whitespace, so stemming the words one by one gives the same lexemes as stemming the whole text.
 */
export function claimWords(text: string): ClaimWord[] {
  const out: ClaimWord[] = [];
  for (const raw of text.split(/\s+/)) {
    const display = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if (!display || FILLER_WORDS.has(display.toLowerCase())) continue;
    const m = /^(\p{L}+)n['’]t$/iu.exec(display);
    const stemKey = m ? (CONTRACTION_BASE[m[1].toLowerCase()] ?? m[1]) : display;
    out.push({ display, stemKey });
  }
  return out;
}

/** Month number by the first three letters of its name. */
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const month = (name: string) => pad(MONTHS[name.slice(0, 3).toLowerCase()]);
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?!\\p{L})\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const NUM = "(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d+))?";
/** A leading minus (- or −) at the start of the text or after whitespace or "(": captured, so -5% is not 5%. */
const SIGN = "(?:(?<=^|[\\s(])([-−]))?";
const signed = (sign: string | undefined, v: string) => (sign ? "-" + v : v);

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

const WORD_NUMBERS: Record<string, number> = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const UNITS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const WORD_SCALE: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

const pad = (n: number) => String(n).padStart(2, "0");

/** A plain decimal string: thousands separators dropped, the scale applied, at most 6 decimals, no trailing zeros. */
function canonNumber(int: string, frac: string | undefined, scale = 1): string {
  const n = Number(int.replace(/,/g, "") + (frac ? "." + frac : "")) * scale;
  return String(Math.round(n * 1e6) / 1e6);
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** A token with both a letter and a digit (F-1, H-1B, ZX-9000, Q3), unless it is a number with a scale or ordinal suffix. */
function isCode(token: string): boolean {
  return /\p{L}/u.test(token) && /\p{N}/u.test(token) && !/^\d+(?:[.,]\d+)*(?:k|m|mm|b|bn|st|nd|rd|th)$/i.test(token);
}

type Rule = [RegExp, (m: string[]) => string | string[] | null];

/**
 * The extraction rules, applied in this order; each match is replaced by a space so later rules cannot read it again.
 * A rule returning null leaves its match in place. The canonical forms:
 *   dates     2026-09-29 (full), 2026-09 (month and year), --09-29 (month and day, no year)
 *   as written  numeric dates (3/4/2026, 29.09.2026), dotted versions (3.12.1), digit groups (555-1234; a range of two
 *             years, 2019-2023, is two years), percent ranges (20-30%): compared exactly as written
 *   sign      a leading - or − at the start, after whitespace or after "(" stays with the number (-5%, -$5000, -2)
 *   money     $115000 ($115k, $115K, $115,000, 115,000 dollars, USD 115000; k/m/b and thousand/million/billion scale)
 *   percent   11% (11%, ~11%, 11 %, 11 percent, 11 per cent)
 *   codes     H-1B, F-1, ZX-9000 (upper-cased tokens with a letter and a digit)
 *   ordinals  3rd, 21st (digits only: "first" is too often not a number)
 *   numbers   1000 (1,000), 1500 (1.5k), 40000000 (40 million), 4 (4+); years are plain numbers (2026)
 *   words     two to ninety, optionally hyphenated with a unit and followed by hundred/thousand/million/billion
 *             ("two hundred" is 200); "one" is not read, since it is usually a pronoun ("one of", "no one")
 */
const RULES: Rule[] = [
  // ISO date, then ISO month.
  [/(?<![\p{N}-])(\d{4})-(\d{2})-(\d{2})(?![\p{N}-])/giu, (m) => `${m[1]}-${m[2]}-${m[3]}`],
  [/(?<![\p{N}-])(\d{4})-(\d{2})(?![\p{N}-])/giu, (m) => (Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${m[1]}-${m[2]}` : null)],
  // Sep 29, 2026 · September 29th 2026 · 29 September 2026 · September 2026.
  [new RegExp(`(?<![\\p{L}])${MONTH}\\s+${DAY},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[3]}-${month(m[1])}-${pad(Number(m[2]))}`],
  [new RegExp(`(?<![\\p{L}\\p{N}])${DAY}\\s+(?:of\\s+)?${MONTH},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[3]}-${month(m[2])}-${pad(Number(m[1]))}`],
  [new RegExp(`(?<![\\p{L}])${MONTH},?\\s+(\\d{4})(?!\\p{N})`, "giu"), (m) => `${m[2]}-${month(m[1])}`],
  // Sep 29 · 29 Sep (no year). A lower-case "may" here is the verb ("5 may help"), not the month.
  [new RegExp(`(?<![\\p{L}])${MONTH}\\s+${DAY}(?![\\p{L}\\p{N}])`, "giu"), (m) => (m[1] === "may" ? null : `--${month(m[1])}-${pad(Number(m[2]))}`)],
  [new RegExp(`(?<![\\p{L}\\p{N}])${DAY}\\s+(?:of\\s+)?${MONTH}`, "giu"), (m) => (m[2] === "may" ? null : `--${month(m[2])}-${pad(Number(m[1]))}`)],
  // As written: numeric dates, dotted versions, percent ranges, digit-only hyphen groups.
  [/(?<![\p{L}\p{N}.\/-])\d{1,4}[/.]\d{1,2}[/.]\d{2,4}(?![\p{L}\p{N}]|[./-]\p{N})/gu, (m) => m[0]],
  [/(?<![\p{L}\p{N}.])\d+(?:\.\d+){2,}(?![\p{L}\p{N}]|\.\p{N})/gu, (m) => m[0]],
  [/(?<![\p{L}\p{N}.\-$,])(\d+-\d+)\s?(?:%|percent(?!\p{L}))/giu, (m) => m[1] + "%"],
  [/(?<![\p{L}\p{N}.\-$,/])\d+(?:-\d+)+(?![\p{L}\p{N}]|-\p{L})/gu, (m) => (/^(?:1[89]|20)\d\d-(?:1[89]|20)\d\d$/.test(m[0]) ? m[0].split("-") : m[0])],
  // Money.
  [new RegExp(`${SIGN}(?:US)?\\$\\s?${NUM}(?:(k|mm|m|bn|b)(?![\\p{L}\\p{N}])|\\s?(thousand|million|billion)(?!\\p{L}))?`, "giu"), (m) => signed(m[1], "$" + canonNumber(m[2], m[3], SCALE[(m[4] ?? m[5] ?? "").toLowerCase()] ?? 1))],
  [new RegExp(`${SIGN}(?<![\\p{L}\\p{N}.])${NUM}(?:\\s?(thousand|million|billion))?\\s+(?:dollars|usd)(?!\\p{L})`, "giu"), (m) => signed(m[1], "$" + canonNumber(m[2], m[3], SCALE[(m[4] ?? "").toLowerCase()] ?? 1))],
  [new RegExp(`(?<![\\p{L}])usd\\s?${NUM}`, "giu"), (m) => "$" + canonNumber(m[1], m[2])],
  // Percent.
  [new RegExp(`${SIGN}(?<![\\p{L}\\p{N}.])${NUM}\\s?(?:%|percent(?!\\p{L})|per\\s+cent(?!\\p{L}))`, "giu"), (m) => signed(m[1], canonNumber(m[2], m[3]) + "%")],
  // Codes.
  [/(?<![\p{L}\p{N}-])[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)+(?![\p{L}\p{N}])|(?<![\p{L}\p{N}-])[\p{L}\p{N}]+(?![\p{L}\p{N}-])/gu, (m) => (isCode(m[0]) ? m[0].toUpperCase() : null)],
  // Ordinals.
  [/(?<![\p{L}\p{N}])(\d+)(?:st|nd|rd|th)(?![\p{L}\p{N}])/giu, (m) => ordinal(Number(m[1]))],
  // Plain numbers, with an attached k/m/b or a following thousand/million/billion.
  [new RegExp(`${SIGN}(?<![\\p{L}\\p{N}.])${NUM}(?:(k|mm|m|bn|b)(?![\\p{L}\\p{N}])|\\s?(thousand|million|billion)(?!\\p{L}))?`, "giu"), (m) => signed(m[1], canonNumber(m[2], m[3], SCALE[(m[4] ?? m[5] ?? "").toLowerCase()] ?? 1))],
  // Number words.
  [
    /(?<![\p{L}-])(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:-(one|two|three|four|five|six|seven|eight|nine))?(?:\s+(hundred|thousand|million|billion))?(?![\p{L}-])/giu,
    (m) => String((WORD_NUMBERS[m[1].toLowerCase()] + (m[2] ? UNITS[m[2].toLowerCase()] : 0)) * (m[3] ? WORD_SCALE[m[3].toLowerCase()] : 1)),
  ],
];

/**
 * The numbers, dates and codes in a text, in canonical form (see RULES), and the text with them blanked out (`rest`),
 * which is what content terms are read from, so "2026" or "H-1B" is checked as a number or code, never as a word.
 */
export function extractNumbers(text: string): { values: string[]; rest: string } {
  const values: string[] = [];
  let rest = text;
  for (const [re, canon] of RULES) {
    rest = rest.replace(re, (match: string, ...more: unknown[]) => {
      // more is the capture groups (string or undefined), then the match offset (a number), then the whole string.
      const m = [match, ...(more.slice(0, more.findIndex((x) => typeof x === "number")) as string[])];
      const v = canon(m);
      if (v === null) return match;
      values.push(...(Array.isArray(v) ? v : [v]));
      return " ";
    });
  }
  return { values, rest };
}

/**
 * What the cited texts state, for matching a claim's numbers: each canonical value, plus what it implies. A full date
 * also states its month (2026-09), its year (2026) and its month-day (--09-29); a month states its year; a sum of money
 * also states the bare amount ($115000 states 115000). Nothing else is implied: a claim's "$115000" needs "$" in the
 * source (or "dollars"/"USD"), and a percentage needs "%" (or "percent").
 */
export function citedNumberSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const v of values) {
    out.add(v);
    let m: RegExpExecArray | null;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v))) out.add(`${m[1]}-${m[2]}`).add(m[1]).add(`--${m[2]}-${m[3]}`);
    else if ((m = /^(\d{4})-(\d{2})$/.exec(v))) out.add(m[1]);
    else if ((m = /^(-?)\$(.+)$/.exec(v))) out.add(m[1] + m[2]);
  }
  return out;
}

/** Never ends a sentence: titles, Latin abbreviations, U.S./U.K. and month abbreviations ("e.g. Snowflake", "Dr. Smith", "Jan. 2024"). */
const NEVER_ENDS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "e.g", "i.e", "vs", "cf", "approx", "no", "fig", "u.s", "u.k",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/**
 * Splits text into sentences. Every line break ends a sentence, and a leading list marker (-, *, •, 1., 1)) is dropped.
 * Within a line, a sentence ends at . ! or ? (with any closing quotes or brackets and any citation labels such as
 * [P1] that follow it) when whitespace follows and the next word does not start with a lower-case letter. A full stop
 * does not end a sentence after an abbreviation in NEVER_ENDS or a single-letter initial ("J. Smith"); a decimal
 * point never does, since no whitespace follows it.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (!line) continue;
    let start = 0;
    const re = /[.!?]+["'”’)\]]*(?:\s*\[[^\]\n]{1,40}\])*(?=\s|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) {
      const end = m.index + m[0].length;
      const next = line.slice(end).trimStart();
      if (next === "") break;
      if (line[m.index] === ".") {
        const before = line.slice(start, m.index).split(/\s+/).pop()!.replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
        if (NEVER_ENDS.has(before) || /^\p{L}$/u.test(before)) continue;
        if (/^\p{Ll}/u.test(next)) continue;
      }
      out.push(line.slice(start, end).trim());
      start = end;
    }
    const tail = line.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}
