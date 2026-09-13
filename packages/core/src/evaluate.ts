import { isAsciiWhitespace } from "./text.js";
import { U } from "./bytes.js";
import { fail, invariant } from "./errors.js";
import { parseFact, stripTerminal } from "./grammar.js";
import { splitCandidates, splitComponents, type Candidate } from "./split.js";
import { alignFact, buildSourceIndex, type SourceIndex } from "./align.js";
import type { AtomResult, ClaimResult, Hash, Link, Retrieval, Source } from "./types.js";

/**
 * Candidate/atom evaluation. Atom indices restart per claim; claim indices are
 * zero-based in document order. Verdict precedence: contradicted, then
 * unsupported, then supported.
 */

export const MAX_CLAIMS = 128;
export const MAX_ATOMS = 8;
const RETAIN_LINKS = 4;

function trimSpanText(bytes: Uint8Array, span: { start: number; end: number }): { start: number; end: number } {
  let a = span.start;
  let b = span.end;
  while (a < b && isAsciiWhitespace(bytes[a]!)) a++;
  while (b > a && isAsciiWhitespace(bytes[b - 1]!)) b--;
  return { start: a, end: b };
}

function evalAtom(
  index: number,
  span: { start: number; end: number },
  atomText: string,
  idx: SourceIndex,
  retrievalHash: Hash,
): AtomResult {
  const parsed = parseFact(stripTerminal(atomText));
  if (!parsed.ok) {
    return {
      index,
      span,
      verdict: "unsupported",
      reason: parsed.reason,
      links: [],
      totals: { supports: 0, contradicts: 0 },
    };
  }
  const m = alignFact(idx, parsed.fact);
  const totalS = m.supports.length;
  const totalC = m.contradicts.length;

  const toLink = (relation: "supports" | "contradicts") =>
    m[relation === "supports" ? "supports" : "contradicts"]
      .map(
        (p): Link => ({
          relation,
          source_id: p.source.source_id,
          span: p.span,
          content_hash: p.source.content_hash,
          retrieval_hash: retrievalHash,
        }),
      )
      .sort(
        (a, b) =>
          a.source_id < b.source_id ? -1 : a.source_id > b.source_id ? 1 : a.span.start - b.span.start || a.span.end - b.span.end,
      )
      .slice(0, RETAIN_LINKS);

  const links = [...toLink("supports"), ...toLink("contradicts")];

  if (totalC > 0) {
    return { index, span, verdict: "contradicted", reason: "CONFLICT", links, totals: { supports: totalS, contradicts: totalC } };
  }
  if (totalS > 0) {
    return { index, span, verdict: "supported", reason: "MATCH", links, totals: { supports: totalS, contradicts: totalC } };
  }
  const reason = m.matchingSecondary ? "PRIMARY_REQUIRED" : m.matchingContextual ? "CONTEXT" : "NO_EVIDENCE";
  return { index, span, verdict: "unsupported", reason, links, totals: { supports: 0, contradicts: 0 } };
}

/** Enforce claim/atom caps and evaluate one draft against the index. */
export function evaluateDraft(
  draft: string,
  sources: Source[],
  retrievalHash: Hash,
  observe?: (name: "pc_source_parse_ms", ms: number) => void,
): ClaimResult[] {
  const candidates = splitCandidates(draft);
  if (candidates.length > MAX_CLAIMS) fail("LIMIT_EXCEEDED", "/draft");
  const t0 = performance.now();
  const idx = buildSourceIndex(sources);
  observe?.("pc_source_parse_ms", performance.now() - t0);
  const draftBytes = U(draft);
  const claims: ClaimResult[] = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    claims.push(evalCandidate(ci, candidates[ci]!, idx, retrievalHash, draftBytes));
  }
  return claims;
}

function evalCandidate(
  index: number,
  cand: Candidate,
  idx: SourceIndex,
  retrievalHash: Hash,
  draftBytes: Uint8Array,
): ClaimResult {
  const components = splitComponents(cand);
  if (components.length > MAX_ATOMS) fail("LIMIT_EXCEEDED", "/draft");

  const atoms: AtomResult[] = [];
  const hasEmpty = components.some((c) => {
    const t = trimSpanText(draftBytes, c.span);
    return t.start === t.end;
  });

  if (hasEmpty) {
    // Empty conjunct: one atom covering the whole candidate, SYNTAX.
    atoms.push({
      index: 0,
      span: cand.span,
      verdict: "unsupported",
      reason: "SYNTAX",
      links: [],
      totals: { supports: 0, contradicts: 0 },
    });
  } else {
    for (let ai = 0; ai < components.length; ai++) {
      const t = trimSpanText(draftBytes, components[ai]!.span);
      invariant(t.start < t.end, "zero-length atom span");
      const text = new TextDecoder().decode(draftBytes.subarray(t.start, t.end));
      atoms.push(evalAtom(ai, t, text, idx, retrievalHash));
    }
  }

  let verdict: ClaimResult["verdict"];
  let reason: ClaimResult["reason"];
  if (atoms.some((a) => a.verdict === "contradicted")) {
    verdict = "contradicted";
    reason = "ATOM_CONTRADICTED";
  } else if (atoms.some((a) => a.verdict === "unsupported")) {
    verdict = "unsupported";
    reason = "ATOM_UNSUPPORTED";
  } else {
    verdict = "supported";
    reason = "ALL_SUPPORTED";
  }
  return { index, span: cand.span, verdict, reason, atoms };
}

export { buildSourceIndex };
export type { Retrieval };
