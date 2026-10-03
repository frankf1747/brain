import { describe, it, expect } from "vitest";
import {
  extractNumbers, citedNumberSet, hasNegation, claimWords, isContentLexeme, splitSentences, polarityWords, isNumberWord, POLARITY_WORDS,
} from "../../src/verify/terms.js";

const values = (t: string) => extractNumbers(t).values;

describe("extractNumbers", () => {
  it("normalises thousands separators and percent forms", () => {
    expect(values("lifted ~11% and 1,000 orders")).toEqual(["11%", "1000"]);
    expect(values("11 % or 11 percent or 11 per cent")).toEqual(["11%", "11%", "11%"]);
    expect(values("4+ years, about 300 people, 2.50 hours")).toEqual(["4", "300", "2.5"]);
  });

  it("gives $115k, $115K, $115,000, 115,000 dollars and USD 115000 one form, and applies k/m/b scales", () => {
    expect(values("$115k, $115K, $115,000, 115,000 dollars, USD 115000")).toEqual(["$115000", "$115000", "$115000", "$115000", "$115000"]);
    expect(values("$40M, $40 million, $1.5B, 1.5k orders, 2 million users")).toEqual(["$40000000", "$40000000", "$1500000000", "1500", "2000000"]);
  });

  it("reads ISO and written dates as ISO, a month with a year as YYYY-MM, and a month and day as --MM-DD", () => {
    expect(values("Sep 29, 2026; September 29th 2026; 29 September 2026; 2026-09-29")).toEqual(["2026-09-29", "2026-09-29", "2026-09-29", "2026-09-29"]);
    expect(values("in March 2026, 2026-03, and on October 6 or 6 Oct")).toEqual(["2026-03", "2026-03", "--10-06", "--10-06"]);
    expect(values("AUSTIN, March 12, 2026. Founded in 2019.")).toEqual(["2026-03-12", "2019"]);
  });

  it("does not read a lower-case may followed by or following a number as a month", () => {
    expect(values("the top 5 may help")).toEqual(["5"]);
    expect(values("on May 5")).toEqual(["--05-05"]);
  });

  it("keeps codes whole and upper-cased, so the digits of F-1 or ZX-9000 are never read as numbers", () => {
    expect(values("on F-1 OPT, sponsors h-1b, the ZX-9000 and X-90, in Q3")).toEqual(["F-1", "H-1B", "ZX-9000", "X-90", "Q3"]);
    expect(values("ranges 2019-2023")).toEqual(["2019", "2023"]);
  });

  it("reads digit ordinals and number words, but not 'one' or 'first'", () => {
    expect(values("the 3rd, 21st and 12th")).toEqual(["3rd", "21st", "12th"]);
    expect(values("two hundred workers, three finalists, twenty-five seats, one of the first")).toEqual(["200", "3", "25"]);
  });

  it("blanks what it extracted, so the rest has only words", () => {
    expect(extractNumbers("Acme pays $115k on F-1 since 2019").rest.split(/\s+/).filter(Boolean)).toEqual(["Acme", "pays", "on", "since"]);
  });
});

describe("citedNumberSet", () => {
  it("adds what a cited value implies: a date's month, year and month-day; a sum's bare amount", () => {
    expect([...citedNumberSet(["2026-09-29", "$115000", "2026-03", "11%"])].sort()).toEqual(
      ["$115000", "--09-29", "11%", "115000", "2026", "2026-03", "2026-09", "2026-09-29"],
    );
  });
});

describe("hasNegation", () => {
  it("finds not, no, never, without, none, neither, nor, cannot and n't as whole words, in any case", () => {
    for (const t of ["Acme does not sponsor", "No.", "never again", "without a visa", "none of them", "neither", "nor", "I cannot", "Acme doesn't", "Acme doesn’t", "It WON'T"]) {
      expect([t, hasNegation(t)]).toEqual([t, true]);
    }
    for (const t of ["Acme sponsors H-1B", "nothing notable", "knowledge", "Nordic", "nonetheless", "denote"]) {
      expect([t, hasNegation(t)]).toEqual([t, false]);
    }
  });
});

describe("claimWords and isContentLexeme", () => {
  it("strips punctuation for display and reduces negative contractions to their base for stemming", () => {
    expect(claimWords(`Acme doesn't, won't sponsor "visas".`)).toEqual([
      { display: "Acme", stemKey: "Acme" },
      { display: "doesn't", stemKey: "does" },
      { display: "won't", stemKey: "will" },
      { display: "sponsor", stemKey: "sponsor" },
      { display: "visas", stemKey: "visas" },
    ]);
  });

  it("skips answer and connective words, which state nothing a source could confirm", () => {
    expect(claimWords("Yes, however Acme also sponsors").map((w) => w.display)).toEqual(["Acme", "sponsors"]);
    expect(claimWords("Yes.")).toEqual([]);
  });

  it("counts lexemes with a letter, except negation words", () => {
    expect(["databrick", "h-1b", "115k", "2026", "-09", "never", "without", "none", "neither", "cannot"].map(isContentLexeme)).toEqual(
      [true, true, true, false, false, false, false, false, false, false],
    );
  });
});

describe("splitSentences", () => {
  it("splits on . ! ? and line breaks, keeps labels with their sentence, and drops list markers", () => {
    expect(splitSentences("Acme sponsors visas [P1]. It is hybrid. [P2] Is it remote? No!\n- first point\n2. second point")).toEqual([
      "Acme sponsors visas [P1].", "It is hybrid. [P2]", "Is it remote?", "No!", "first point", "second point",
    ]);
  });

  it("does not split after abbreviations, initials or decimal points, or before a lower-case word", () => {
    expect(splitSentences("Use a warehouse, e.g. Snowflake. Dr. Smith and J. Doe agreed 1.5 was fine. U.S. firms pay more. It rose ca. two points.")).toEqual([
      "Use a warehouse, e.g. Snowflake.", "Dr. Smith and J. Doe agreed 1.5 was fine.", "U.S. firms pay more.", "It rose ca. two points.",
    ]);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences(" \n\n ")).toEqual([]);
  });
});

describe("extractNumbers: signs, versions, numeric dates and digit groups (review fixes)", () => {
  it("keeps a leading minus at the start, after whitespace or after (, so -5% is not 5%", () => {
    expect(values("-5% overall, then −3%, (-2 to 4) and -$5k")).toEqual(["-$5000", "-5%", "-3%", "-2", "4"]);
    expect(values("-5 degrees")).toEqual(["-5"]);
    expect(values("5 degrees")).toEqual(["5"]);
    expect(values("- 4+ years")).toEqual(["4"]);
  });

  it("keeps dotted versions whole: v2.5 is not v2.7, 3.12.1 is not 3.12.9", () => {
    expect(values("dbt v2.5 and V2.7")).toEqual(["V2.5", "V2.7"]);
    expect(values("Python 3.12.1, not 3.12.9; IP 10.0.0.1")).toEqual(["3.12.1", "3.12.9", "10.0.0.1"]);
    expect(values("1.5k orders and 2.50 hours")).toEqual(["1500", "2.5"]);
  });

  it("keeps numeric dates, digit-only hyphen groups and percent ranges exactly as written", () => {
    expect(values("Started 3/4/2026")).toEqual(["3/4/2026"]);
    expect(values("on 29.09.2026")).toEqual(["29.09.2026"]);
    expect(values("call 555-1234")).toEqual(["555-1234"]);
    expect(values("churn fell 20-30%")).toEqual(["20-30%"]);
    expect(values("March 2026 with 4 people and 3 laptops")).toEqual(["2026-03", "4", "3"]);
  });
});

describe("polarityWords", () => {
  it("lists the direction, order, comparison, scope and modality words Postgres drops, as whole words, lower-cased", () => {
    expect(POLARITY_WORDS).toEqual(expect.arrayContaining(["up", "down", "before", "after", "over", "under", "more", "less", "all", "some", "only", "will", "might"]));
    expect([...polarityWords("Retention went UP before the launch; only some will")].sort()).toEqual(["before", "only", "some", "up", "will"]);
    expect([...polarityWords("upper downtown overall allow cannery")]).toEqual([]);
  });

  it("reads won't, can't, cannot and shouldn't as will, can, can and should", () => {
    expect([...polarityWords("Acme won't, can't, cannot, shouldn't")].sort()).toEqual(["can", "should", "will"]);
  });
});

describe("isNumberWord", () => {
  it("is true for number words and ordinal words, including hyphenated ones, in any case", () => {
    expect(["one", "First", "dozen", "tenth", "seven", "twenty-first", "hundreds"].map(isNumberWord)).toEqual([true, true, true, true, true, true, true]);
    expect(["patent", "someone", "often", "Acme"].map(isNumberWord)).toEqual([false, false, false, false]);
  });
});

describe("splitSentences: month abbreviations", () => {
  it("does not end a sentence after Jan. Feb. … Sept. Dec.", () => {
    expect(splitSentences("He joined in Jan. 2024. He left in Sept. 2025.")).toEqual(["He joined in Jan. 2024.", "He left in Sept. 2025."]);
    expect(splitSentences("joined in Jan. 2024. He left")).toEqual(["joined in Jan. 2024.", "He left"]);
  });
});
