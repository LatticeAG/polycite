import { U, utf8Length } from "./bytes.js";
import { hashUtf8 } from "./crypto.js";
import { isRemovableAtom } from "./grammar.js";
import type { ClaimResult, Hash, Rewrite } from "./types.js";

/**
 * §5.6 unsupported-only pruning: one deterministic pass that removes removable
 * unsupported atoms from mixed candidates, applied right-to-left on original
 * byte offsets. Never repairs contradictions and never invents replacement text.
 */
export async function applyPruning(
  draft: string,
  claims: ClaimResult[],
): Promise<{ finalText: string; rewrites: Rewrite[] }> {
  const draftBytes = U(draft);
  const dec = new TextDecoder();
  const patches: { start: number; end: number; replacement: Uint8Array }[] = [];
  const rewrites: Rewrite[] = [];

  for (const claim of claims) {
    if (claim.verdict !== "unsupported") continue;
    const supported = claim.atoms.filter((a) => a.verdict === "supported");
    if (supported.length === 0) continue;
    const removable = claim.atoms.every(
      (a) =>
        a.verdict === "supported" ||
        isRemovableAtom(dec.decode(draftBytes.subarray(a.span.start, a.span.end))),
    );
    if (!removable) continue;

    const retained = supported.map((a) => {
      let t = dec.decode(draftBytes.subarray(a.span.start, a.span.end));
      if (t.endsWith(".") || t.endsWith(";")) t = t.slice(0, -1);
      return t;
    });
    const replacement = retained.join(" and ") + ".";
    const candText = dec.decode(draftBytes.subarray(claim.span.start, claim.span.end));
    if (utf8Length(replacement) >= utf8Length(candText)) continue;

    rewrites.push({
      claim_index: claim.index,
      original_span: claim.span,
      removed_atoms: claim.atoms.filter((a) => a.verdict === "unsupported").map((a) => a.index),
      before_hash: await hashUtf8(candText),
      after_hash: await hashUtf8(replacement),
      replacement,
    });
    patches.push({ start: claim.span.start, end: claim.span.end, replacement: U(replacement) });
  }

  if (patches.length === 0) return { finalText: draft, rewrites: [] };

  patches.sort((a, b) => b.start - a.start);
  let bytes = draftBytes;
  for (const p of patches) {
    const next = new Uint8Array(p.start + p.replacement.length + (bytes.length - p.end));
    next.set(bytes.subarray(0, p.start), 0);
    next.set(p.replacement, p.start);
    next.set(bytes.subarray(p.end), p.start + p.replacement.length);
    bytes = next;
  }
  return { finalText: dec.decode(bytes), rewrites };
}

export type { Hash };
