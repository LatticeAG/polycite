import { U } from "./bytes.js";
import { factsAgree, matchKey, parseFact, stripTerminal, type Fact } from "./grammar.js";
import { isAsciiWhitespace } from "./text.js";
import type { Source, Span } from "./types.js";

/**
 * Source-span aligner. Source text splits into paragraphs at LF/CR; a paragraph
 * is eligible iff it is exactly one recognized FACT (optional final `.`/`;`)
 * inside a primary, standalone source. Only eligible paragraphs contribute
 * evidence. Secondary and contextual paragraphs are indexed separately for
 * unsupported-reason selection only.
 */

export interface ParaMatch {
  fact: Fact;
  span: Span;
  source: Source;
}

export interface SourceIndex {
  /** matchKey -> eligible primary/standalone paragraph matches. */
  eligible: Map<string, ParaMatch[]>;
  /** matchKey -> true when any role=secondary source has a matching paragraph. */
  secondary: Set<string>;
  /** matchKey -> true when any primary+contextual source has a matching paragraph. */
  contextual: Set<string>;
}

interface RawPara {
  span: Span;
  text: string;
}

function paragraphs(text: string): RawPara[] {
  const bytes = U(text);
  const out: RawPara[] = [];
  let start = 0;
  const push = (a: number, b: number) => {
    while (a < b && isAsciiWhitespace(bytes[a]!)) a++;
    while (b > a && isAsciiWhitespace(bytes[b - 1]!)) b--;
    if (a === b) return;
    out.push({ span: { start: a, end: b }, text: new TextDecoder().decode(bytes.subarray(a, b)) });
  };
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0a || bytes[i] === 0x0d) {
      push(start, i);
      start = i + 1;
    }
  }
  push(start, bytes.length);
  return out;
}

export function buildSourceIndex(sources: Source[]): SourceIndex {
  const idx: SourceIndex = { eligible: new Map(), secondary: new Set(), contextual: new Set() };
  for (const s of sources) {
    for (const para of paragraphs(s.text)) {
      const parsed = parseFact(stripTerminal(para.text));
      if (!parsed.ok) continue;
      const key = matchKey(parsed.fact);
      if (s.role === "primary" && s.extraction === "standalone") {
        const list = idx.eligible.get(key) ?? [];
        list.push({ fact: parsed.fact, span: para.span, source: s });
        idx.eligible.set(key, list);
      } else if (s.role === "secondary") {
        idx.secondary.add(key);
      } else {
        idx.contextual.add(key);
      }
    }
  }
  return idx;
}

export interface AlignResult {
  supports: ParaMatch[];
  contradicts: ParaMatch[];
  matchingSecondary: boolean;
  matchingContextual: boolean;
}

export function alignFact(idx: SourceIndex, fact: Fact): AlignResult {
  const key = matchKey(fact);
  const all = idx.eligible.get(key) ?? [];
  const supports: ParaMatch[] = [];
  const contradicts: ParaMatch[] = [];
  for (const m of all) {
    if (factsAgree(fact, m.fact)) supports.push(m);
    else contradicts.push(m);
  }
  return {
    supports,
    contradicts,
    matchingSecondary: idx.secondary.has(key),
    matchingContextual: idx.contextual.has(key),
  };
}
