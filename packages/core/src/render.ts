import { U } from "./bytes.js";
import { hashUtf8 } from "./crypto.js";
import { J } from "./jcs.js";
import type { ClaimResult, Decision, Hash, Outcome } from "./types.js";

/** §6.2 exact plain-text rendering. */

const dec = () => new TextDecoder();

export function renderText(decision: Decision, finalText: string): string | null {
  if (decision.outcome === "blocked") return null;
  const finalBytes = U(finalText);
  const parts = decision.final.map((claim) => candidateLine(claim, finalBytes, decision.outcome));
  const body = parts.join("\n");
  const ledger = dec().decode(J(decision));
  return body + "\n\nPolyCite ledger:\n" + ledger + "\n";
}

function candidateLine(claim: ClaimResult, finalBytes: Uint8Array, outcome: Outcome): string {
  const text = dec().decode(finalBytes.subarray(claim.span.start, claim.span.end));
  if (outcome === "annotated") {
    return `[${claim.verdict.toUpperCase()} pc:${claim.index}] ` + text;
  }
  return text + ` [pc:${claim.index}]`;
}

export async function deliveryHash(text: string | null): Promise<Hash | null> {
  return text === null ? null : hashUtf8(text);
}
