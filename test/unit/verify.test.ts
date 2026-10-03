import { describe, it, expect } from "vitest";
import {
  judge, checkClaim, stemInputs, stripLabels, summarizeVerdicts, verdictOf, passageText, factText, SUPPORTED_MIN, PARTIAL_MIN,
  type BadLabel, type CitedText,
} from "../../src/verify/verify.js";
import type { StemMap } from "../../src/verify/terms.js";

/**
 * A stand-in for Postgres's english stemming, so these tests need no database: lower-case, split on anything but
 * letters, digits, hyphens and apostrophes, drop a possessive 's and a small stopword list, and strip a final s from
 * words longer than three letters. test/integration/verify-terms.test.ts checks the real stems.
 */
const STOP = new Set("a an the is are was were be been to of in on for and or it its i am has have had that this with at by as from not no nor does do did will can he she they we".split(" "));
function fakeLexemes(s: string): string[] {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^\p{L}\p{N}'’-]+/u)) {
    const w = raw.replace(/['’]s$/, "").replace(/^[-'’]+|[-'’]+$/g, "");
    if (!w || STOP.has(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return [...out].sort();
}
const stemsFor = (claim: string, cited: CitedText[]): StemMap => new Map(stemInputs(claim, cited).map((s) => [s, fakeLexemes(s)]));

const P = (text: string, label = "P1"): CitedText => ({ label, kind: "passage", text });
const F = (predicate: string, objectText: string, label = "F1"): CitedText => ({ label, kind: "fact", text: factText(predicate, objectText) });

function run(claim: string, cited: CitedText[], bad: BadLabel[] = []) {
  return judge({ text: claim, labels: [...cited.map((c) => c.label), ...bad.map((b) => b.label)], cited, cites: [], badLabels: bad }, stemsFor(claim, cited));
}

describe("verdicts", () => {
  it("an exact restatement is supported with support 1", () => {
    const r = run("Acme sponsors H-1B visas.", [P("Acme sponsors H-1B for this role and other visas.")]);
    expect(r).toMatchObject({ verdict: "supported", support: 1, matchedTerms: ["Acme", "sponsors", "visas"], missingTerms: [], missingNumbers: [], negationMismatch: false });
  });

  it("a paraphrase with half its terms in the source is partial, and missingTerms are the claim's own words", () => {
    const r = run("Acme pays engineers well in Denver offices.", [P("Acme pays well.")]);
    expect(r).toMatchObject({ verdict: "partial", support: 0.5, matchedTerms: ["Acme", "pays", "well"], missingTerms: ["engineers", "Denver", "offices"] });
  });

  it("an unrelated claim is unsupported", () => {
    const r = run("Northwind hired a product analyst in Denver.", [P("Acme sponsors visas.")]);
    expect(r).toMatchObject({ verdict: "unsupported", support: 0, missingTerms: ["Northwind", "hired", "product", "analyst", "Denver"] });
  });

  it("applies the thresholds exactly: 0.6 is supported, 0.3 is partial, below 0.3 is unsupported", () => {
    expect(SUPPORTED_MIN).toBe(0.6);
    expect(PARTIAL_MIN).toBe(0.3);
    const src = [P("alpha bravo charlie")];
    expect(run("alpha bravo charlie delta echo", src)).toMatchObject({ verdict: "supported", support: 0.6 });
    expect(run("alpha bravo delta echo foxtrot", src)).toMatchObject({ verdict: "partial", support: 0.4 });
    expect(run("alpha bravo charlie delta echo foxtrot golf hotel india juliet", src)).toMatchObject({ verdict: "partial", support: 0.3 });
    expect(run("alpha delta echo foxtrot", src)).toMatchObject({ verdict: "unsupported", support: 0.25 });
  });

  it("a claim with no cites is uncited, whatever it says", () => {
    expect(run("Acme sponsors visas.", [])).toMatchObject({ verdict: "uncited", support: null, matchedTerms: [], missingTerms: [] });
  });

  it("a claim whose only cite does not exist is bad_citation", () => {
    const r = run("Acme sponsors visas.", [], [{ label: "P99", reason: "no P99 in this search (it returned 3 passages)" }]);
    expect(r).toMatchObject({ verdict: "bad_citation", support: null, labels: ["P99"], badLabels: [{ label: "P99" }] });
  });

  it("a claim with good and bad cites is judged on the good ones, and still reports the bad ones", () => {
    const r = run("Acme sponsors visas.", [P("Acme sponsors visas.")], [{ label: "P9", reason: "no P9" }]);
    expect(r).toMatchObject({ verdict: "supported", labels: ["P1", "P9"], badLabels: [{ label: "P9", reason: "no P9" }] });
  });

  it("a claim spanning two passages is supported by their union, and only partial by either alone", () => {
    const claim = "Acme sponsors visas; the role is hybrid with good salary.";
    const a = P("Acme sponsors visas.", "P1");
    const b = P("The role is hybrid and the salary is good.", "P2");
    expect(run(claim, [a, b])).toMatchObject({ verdict: "supported", support: 1 });
    expect(run(claim, [a]).verdict).toBe("partial");
    expect(run(claim, [b]).verdict).toBe("partial");
  });

  it("a fact is cited as its predicate with spaces plus its object", () => {
    expect(factText("visa_status", "F-1 OPT")).toBe("visa status: F-1 OPT");
    expect(run("Visa status is F-1 OPT.", [F("visa_status", "F-1 OPT")])).toMatchObject({ verdict: "supported", support: 1 });
  });

  it("a passage's heading path counts as cited text", () => {
    expect(passageText(["Compensation and visa"], "Acme sponsors H-1B.")).toBe("Compensation and visa\nAcme sponsors H-1B.");
    expect(passageText([], "Body")).toBe("Body");
    expect(run("Compensation includes a visa.", [P(passageText(["Compensation and visa"], "Base pay is listed."))]).verdict).toBe("supported");
  });
});

describe("numbers and dates", () => {
  it("a number the source does not state caps the claim at partial and is listed", () => {
    const r = run("Acme pays $140,000.", [P("Acme pays $115,000 base.")]);
    expect(r).toMatchObject({ verdict: "partial", support: 1, missingNumbers: ["$140000"] });
  });

  it("a missing number never raises a verdict above unsupported", () => {
    expect(run("Northwind hired 9 analysts in Denver.", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "unsupported", missingNumbers: ["9"] });
  });

  it("matches $115k to $115,000, ~11% to 11 percent, and a written date to an ISO one", () => {
    expect(run("Acme pays $115k.", [P("Acme pays $115,000.")]).verdict).toBe("supported");
    expect(run("Retention rose ~11%.", [P("Retention rose 11 percent.")]).verdict).toBe("supported");
    expect(run("The screen is on Sep 22, 2026.", [P("SQL screen on 2026-09-22.")]).verdict).toBe("supported");
  });

  it("a full date in the source also states its year and its month", () => {
    expect(run("The screen is in 2026.", [P("SQL screen on 2026-09-22.")])).toMatchObject({ verdict: "supported", missingNumbers: [] });
    expect(run("The screen is in September 2026.", [P("SQL screen on 2026-09-22.")])).toMatchObject({ verdict: "supported", missingNumbers: [] });
  });

  it("a code must appear as written: ZX-8000 is not ZX-9000", () => {
    expect(run("Acme makes the ZX-8000 drill.", [P("Acme makes the ZX-9000 drill.")])).toMatchObject({ verdict: "partial", support: 1, missingNumbers: ["ZX-8000"] });
  });
});

describe("negation", () => {
  it("a negated claim whose source does not negate is capped at partial", () => {
    expect(run("Acme does not sponsor visas.", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "partial", support: 1, negationMismatch: true });
  });

  it("a plain claim whose source negates a matched term in the same sentence is capped at partial", () => {
    expect(run("Acme sponsors visas.", [P("Acme does not sponsor visas.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
  });

  it("a negated claim with a negated source is supported, contractions included", () => {
    expect(run("Acme doesn't sponsor visas.", [P("Acme does not sponsor visas.")])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });

  it("a verbatim sentence is supported even when another cited sentence negates one of its words", () => {
    const src = P("Each squad created its own cluster and nobody shut them down. Because no cluster carried a tag, spend was unknown.");
    expect(run("Each squad created its own cluster.", [src])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });

  it("negation is compared with the best-matching sentences only: a negation elsewhere does not excuse a negated claim", () => {
    expect(run("Acme does not sponsor visas.", [P("Acme sponsors visas. Not every visa is approved.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
  });

  it("when no sentence holds half the matched terms, the sentences holding the most decide", () => {
    const claim = "Alpha bravo charlie delta echo.";
    expect(run(claim, [P("Alpha bravo is not here. Charlie. Delta. Echo.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
    expect(run(claim, [P("Alpha bravo here. Charlie is not. Delta. Echo.")])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });

  it("a negation in a source sentence without a matched term does not count", () => {
    expect(run("Acme sponsors visas.", [P("Acme sponsors visas. The weather was not warm.")])).toMatchObject({ verdict: "supported", negationMismatch: false });
  });
});

describe("claims without content terms", () => {
  it("'Yes [P1].' is supported: it has no terms, numbers or negation to check", () => {
    expect(run("Yes [P1].", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "supported", support: null, matchedTerms: [], missingTerms: [] });
  });

  it("'No [P1].' is partial: its negation is not in the source", () => {
    expect(run("No [P1].", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "partial", negationMismatch: true });
  });

  it("a bare figure is partial when the source states it and unsupported when it does not", () => {
    expect(run("$115,000 to $140,000 [P1].", [P("Base salary range $115,000 to $140,000.")])).toMatchObject({ verdict: "partial", support: null, missingNumbers: [] });
    expect(run("$150,000 [P1].", [P("Base salary range $115,000 to $140,000.")])).toMatchObject({ verdict: "unsupported", missingNumbers: ["$150000"] });
  });

  it("'Yes.' with no cite is uncited", () => {
    expect(run("Yes.", []).verdict).toBe("uncited");
  });
});

describe("review fixes: false claims that must not be supported", () => {
  it("a sign is part of the number: -5% is not 5%, -5 degrees is not 5 degrees", () => {
    expect(run("Margins changed by -5%.", [P("Margins changed by 5%.")])).toMatchObject({ verdict: "partial", missingNumbers: ["-5%"] });
    expect(run("The freezer runs at -5 degrees.", [P("The freezer runs at 5 degrees.")])).toMatchObject({ verdict: "partial", missingNumbers: ["-5"] });
    expect(run("Margins changed by -5%.", [P("Margins changed by -5%.")]).verdict).toBe("supported");
  });

  it("a dotted version is compared whole: v2.5 is not v2.7, 3.12.1 is not 3.12.9", () => {
    expect(run("Acme runs dbt v2.5.", [P("Acme runs dbt v2.7.")])).toMatchObject({ verdict: "partial", missingNumbers: ["V2.5"] });
    expect(run("Acme requires Python 3.12.1.", [P("Acme requires Python 3.12.9.")])).toMatchObject({ verdict: "partial", missingNumbers: ["3.12.1"] });
  });

  it("a numeric date or a digit group is compared as written, not as loose numbers", () => {
    expect(run("Frank started 3/4/2026.", [P("Frank started in March 2026 with 4 people and 3 laptops.")])).toMatchObject({ verdict: "partial", missingNumbers: ["3/4/2026"] });
    expect(run("Priya's number is 555-1234.", [P("Priya's number is 555-4321, extension 1234.")])).toMatchObject({ verdict: "partial", missingNumbers: ["555-1234"] });
    expect(run("Churn fell 20-30%.", [P("Churn fell 30% in the 20 largest accounts.")])).toMatchObject({ verdict: "partial", missingNumbers: ["20-30%"] });
  });

  it("every polarity word of the claim must be in the cited text, or the claim is capped at partial", () => {
    const pairs: [string, string, string][] = [
      ["Retention went up 11%.", "Retention went down 11%.", "up"],
      ["Acme hired Dana before the round.", "Acme hired Dana after the round.", "before"],
      ["Acme hires more analysts.", "Acme hires less analysts.", "more"],
      ["All analysts work hybrid.", "Some analysts work hybrid.", "all"],
      ["Acme will open a Denver office.", "Acme might open a Denver office.", "will"],
      ["The project came in over budget.", "The project came in under budget.", "over"],
      ["Only Acme sponsors visas.", "Acme sponsors visas.", "only"],
    ];
    for (const [claim, source, word] of pairs) {
      expect([claim, run(claim, [P(source)])]).toMatchObject([claim, { verdict: "partial", missingPolarity: [word] }]);
    }
    expect(run("Retention went up 11%.", [P("Retention went up 11%.")])).toMatchObject({ verdict: "supported", missingPolarity: [] });
    expect(run("Acme won't sponsor visas.", [P("Acme will not sponsor visas.")])).toMatchObject({ verdict: "supported", missingPolarity: [] });
  });

  it("a term-free claim with a polarity word the source lacks is partial", () => {
    expect(run("It will [P1].", [P("Acme sponsors visas.")])).toMatchObject({ verdict: "partial", support: null, missingPolarity: ["will"] });
  });

  it("a missing number word or ordinal caps the claim at partial", () => {
    expect(run("Acme holds one patent.", [P("Acme holds seven patents.")])).toMatchObject({ verdict: "partial", missingTerms: ["one"] });
    expect(run("Dana was the first hire.", [P("Dana was the tenth hire.")])).toMatchObject({ verdict: "partial", missingTerms: ["first"] });
  });
});

describe("helpers", () => {
  it("stripLabels removes [P1], [F2], [P1, F2] and [P1][F2], and the space they leave before punctuation", () => {
    expect(stripLabels("Acme sponsors visas [P1].")).toBe("Acme sponsors visas.");
    expect(stripLabels("Acme [P1, F2] pays [p3][F4] well [P5; P6] ")).toBe("Acme pays well");
  });

  it("checkClaim refuses a stem map that lacks an input, so a caller cannot judge with missing stems", () => {
    expect(() => checkClaim("Acme sponsors visas.", [P("Acme")], new Map())).toThrow(/no stems for "Acme"/);
  });

  it("verdictOf follows the rule order in its comment", () => {
    const base = { termCount: 2, support: 1, matchedTerms: [], missingTerms: [], numberCount: 0, missingNumbers: [], negationMismatch: false, missingPolarity: [] };
    expect(verdictOf(base, 0, 0)).toBe("uncited");
    expect(verdictOf(base, 0, 1)).toBe("bad_citation");
    expect(verdictOf({ ...base, support: 0.2, missingNumbers: ["5"], negationMismatch: true }, 1, 0)).toBe("unsupported");
    expect(verdictOf({ ...base, negationMismatch: true }, 1, 0)).toBe("partial");
  });

  it("summarizeVerdicts counts each verdict and writes the non-zero counts in verdict order", () => {
    const s = summarizeVerdicts([{ verdict: "partial" }, { verdict: "supported" }, { verdict: "supported" }, { verdict: "bad_citation" }]);
    expect(s).toEqual({ supported: 2, partial: 1, unsupported: 0, uncited: 0, bad_citation: 1, text: "2 supported, 1 partial, 1 bad citation" });
    expect(summarizeVerdicts([]).text).toBe("no claims");
  });
});
