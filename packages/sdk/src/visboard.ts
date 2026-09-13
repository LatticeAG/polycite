import type {
  JsonError,
  Outcome,
  Package,
  SourceId,
  TrustContext,
  Verdict,
} from "@latticeag/polycite-core";
import { J, utf8Decode } from "@latticeag/polycite-core";
import { isJsonError, render, verifyPackage } from "./sdk.js";

/**
 * VisBoard render adapter (§6.2). Produces an inert, structured view over a
 * verified package: status markers precede their claims, links carry only a
 * source ID + byte range for an application-owned inspector, and blocked
 * results expose the fixed withholding message and counts — never the draft.
 * No HTML is produced; consumers must not infer verdicts from link presence.
 */

export interface VisBoardSourceRef {
  source_id: SourceId;
  start: number;
  end: number;
}

export interface VisBoardClaim {
  index: number;
  verdict: Verdict;
  /** Marker rendered before the claim in annotated mode, e.g. "[UNSUPPORTED pc:0]". */
  marker: string | null;
  /** Byte span within the final text. */
  span: { start: number; end: number };
  text: string;
  refs: VisBoardSourceRef[];
}

export interface VisBoardView {
  outcome: Outcome;
  /** Canonical render text including the inline ledger; null when blocked. */
  text: string | null;
  content_type: "text/plain; charset=utf-8";
  claims: VisBoardClaim[];
  /** Canonical decision JSON — the public ledger body. */
  ledger: string;
  /** Present only for blocked outcomes. */
  withheld?: { message: string; counts: Record<Verdict, number> };
}

export async function visBoardView(
  pkg: Package,
  trust: TrustContext,
): Promise<VisBoardView | JsonError> {
  const v = await verifyPackage(pkg, trust);
  if (!v.valid) return v.failure;
  const d = await render(pkg, trust);
  if (isJsonError(d)) return d;

  const decision = pkg.result.decision;
  const finalBytes = new TextEncoder().encode(pkg.result.final_text);
  const claims: VisBoardClaim[] = decision.final.map((c) => ({
    index: c.index,
    verdict: c.verdict,
    marker: decision.outcome === "annotated" ? `[${c.verdict.toUpperCase()} pc:${c.index}]` : null,
    span: c.span,
    text: utf8Decode(finalBytes.subarray(c.span.start, c.span.end)),
    refs: c.atoms.flatMap((a) =>
      a.links.map((l) => ({ source_id: l.source_id, start: l.span.start, end: l.span.end })),
    ),
  }));

  const view: VisBoardView = {
    outcome: decision.outcome,
    text: d.text,
    content_type: d.content_type,
    claims,
    ledger: utf8Decode(J(decision)),
  };

  if (decision.outcome === "blocked") {
    const counts: Record<Verdict, number> = { supported: 0, unsupported: 0, contradicted: 0 };
    for (const c of decision.final) counts[c.verdict]++;
    view.withheld = { message: "Response withheld: citation contract not met", counts };
  }
  return view;
}
