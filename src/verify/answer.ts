import { splitSentences } from "./terms.js";
import { LABEL_GROUP_RE, stripLabels } from "./verify.js";
import { MAX_CLAIM_CHARS, MAX_CLAIMS, type ClaimInput } from "./resolve.js";

/** The [P#] and [F#] labels inside a sentence ([P1], [F2], [P1, F2], [P1][F2]), normalised (p01 is P1), each once, in order. */
export function labelsIn(sentence: string): string[] {
  const out: string[] = [];
  for (const group of sentence.match(LABEL_GROUP_RE) ?? []) {
    for (const l of group.match(/[PF]\d+/gi) ?? []) {
      const label = `${l[0].toUpperCase()}${Number(l.slice(1))}`;
      if (!out.includes(label)) out.push(label);
    }
  }
  return out;
}

/**
 * An answer as claims, the way `brain ask` checks its own answer: one claim per sentence (splitSentences: line breaks,
 * and . ! ? not after an abbreviation, initial or decimal point), citing the labels inside that sentence, with the
 * labels removed from its text. A sentence with no letter or digit once its labels are removed (a lone "[P1]") is
 * skipped. At most MAX_CLAIMS claims are returned (`dropped` counts the rest), and a sentence longer than
 * MAX_CLAIM_CHARS characters is cut to that length.
 */
export function claimsFromAnswer(answer: string): { claims: ClaimInput[]; dropped: number } {
  const all = splitSentences(answer)
    .map((s) => ({ text: stripLabels(s).slice(0, MAX_CLAIM_CHARS), cites: labelsIn(s) }))
    .filter((c) => /[\p{L}\p{N}]/u.test(c.text));
  return { claims: all.slice(0, MAX_CLAIMS), dropped: Math.max(0, all.length - MAX_CLAIMS) };
}
