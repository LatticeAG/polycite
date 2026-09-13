import { U } from "./bytes.js";
import { invariant } from "./errors.js";
import { isAsciiWhitespace } from "./text.js";
import type { Span } from "./types.js";

/** pc-split-1 candidate partition over UTF-8 byte offsets. */

export interface Candidate {
  span: Span;
  text: string;
}

export interface Component {
  span: Span;
  text: string;
}

const LF = 0x0a;
const CR = 0x0d;
const SEMI = 0x3b;
const DOT = 0x2e;
const QUEST = 0x3f;
const BANG = 0x21;

function cpByteLen(cp: number): number {
  if (cp < 0x80) return 1;
  if (cp < 0x800) return 2;
  if (cp < 0x10000) {
    // Unpaired surrogates are rejected before splitting; never reached.
    if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("unpaired surrogate");
    return 3;
  }
  return 4;
}

function isAsciiDigit(cp: number): boolean {
  return cp >= 0x30 && cp <= 0x39;
}

/**
 * Partition the draft into candidate claims. Boundaries: LF, CR, `;`, and
 * `.`/`?`/`!` followed by ASCII whitespace or end of text. A dot between two
 * ASCII digits is not a boundary. Boundary punctuation attaches to the
 * preceding candidate; LF/CR are separators. Spans are trimmed of ASCII
 * whitespace; candidates that become empty are discarded.
 */
export function splitCandidates(draft: string): Candidate[] {
  const bytes = U(draft);
  const cps: { cp: number; start: number; len: number }[] = [];
  let off = 0;
  for (const ch of draft) {
    const cp = ch.codePointAt(0)!;
    const len = cpByteLen(cp);
    cps.push({ cp, start: off, len });
    off += len;
  }
  const total = bytes.length;

  const raw: Span[] = [];
  let candStart = 0;
  const close = (endExclusive: number) => {
    raw.push({ start: candStart, end: endExclusive });
  };

  for (let i = 0; i < cps.length; i++) {
    const { cp, start, len } = cps[i]!;
    if (cp === LF || cp === CR) {
      close(start);
      candStart = start + len;
      continue;
    }
    if (cp === SEMI) {
      close(start + len);
      candStart = start + len;
      continue;
    }
    if (cp === DOT || cp === QUEST || cp === BANG) {
      const prev = i > 0 ? cps[i - 1]!.cp : -1;
      const next = i + 1 < cps.length ? cps[i + 1]!.cp : -1;
      if (cp === DOT && isAsciiDigit(prev) && isAsciiDigit(next)) continue;
      if (next === -1 || isAsciiWhitespace(next)) {
        close(start + len);
        candStart = start + len;
      }
    }
  }
  if (candStart < total) close(total);

  const out: Candidate[] = [];
  for (const r of raw) {
    let a = r.start;
    let b = r.end;
    while (a < b && isAsciiWhitespace(bytes[a]!)) a++;
    while (b > a && isAsciiWhitespace(bytes[b - 1]!)) b--;
    if (a === b) continue;
    out.push({ span: { start: a, end: b }, text: new TextDecoder().decode(bytes.subarray(a, b)) });
  }

  // Coverage audit: every non-whitespace byte occurs in exactly one candidate.
  let ci = 0;
  for (let i = 0; i < cps.length; i++) {
    const { cp, start } = cps[i]!;
    if (isAsciiWhitespace(cp)) continue;
    while (ci < out.length && start >= out[ci]!.span.end) ci++;
    invariant(ci < out.length && start >= out[ci]!.span.start && start < out[ci]!.span.end,
      "coverage gap in candidate partition");
  }
  return out;
}

/**
 * Split one candidate on the exact ASCII delimiter ` and `, excluding the
 * delimiter bytes. Component spans are raw (untrimmed) byte spans; trimming is
 * the caller's concern.
 */
export function splitComponents(cand: Candidate): Component[] {
  const bytes = U(cand.text);
  const delim = U(" and ");
  const out: Component[] = [];
  let segStart = 0;
  let i = 0;
  outer: while (i + delim.length <= bytes.length) {
    for (let k = 0; k < delim.length; k++) {
      if (bytes[i + k] !== delim[k]) {
        i++;
        continue outer;
      }
    }
    out.push({ span: { start: cand.span.start + segStart, end: cand.span.start + i }, text: "" });
    segStart = i + delim.length;
    i = segStart;
  }
  out.push({ span: { start: cand.span.start + segStart, end: cand.span.end }, text: "" });
  for (const c of out) {
    c.text = new TextDecoder().decode(U(cand.text).subarray(c.span.start - cand.span.start, c.span.end - cand.span.start));
  }
  return out;
}
