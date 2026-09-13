import { J } from "./jcs.js";
import { hashHex, hashUtf8 } from "./crypto.js";
import { evaluateDraft } from "./evaluate.js";
import { applyPruning } from "./prune.js";
import { deliveryHash, renderText } from "./render.js";
import type {
  Contract,
  Decision,
  EventPayload,
  Hash,
  Time,
  VerifyRequest,
} from "./types.js";

/**
 * Deterministic decision pipeline shared by check() and verifyPackage replay:
 * initial evaluation -> optional one-pass pruning -> final evaluation ->
 * outcome -> rendering preparation -> expected event payloads.
 */
export interface DeterministicResult {
  decision: Decision;
  final_text: string;
  render_text: string | null;
  delivery_hash: Hash | null;
  payloads: EventPayload[];
}

export async function computeDeterministic(
  request: VerifyRequest,
  contract: Contract,
  as_of: Time,
  timings?: { observe: (name: "pc_source_parse_ms" | "pc_sign_ms", ms: number) => void },
): Promise<DeterministicResult> {
  const contractHash = await hashHex(J(contract));
  const retrievalHash = request.retrieval.hash;
  const requestHash = await hashHex(J(request));
  const sources = request.retrieval.body.sources;

  const initial = evaluateDraft(request.draft, sources, retrievalHash, timings?.observe);

  let finalText = request.draft;
  let rewrites: import("./types.js").Rewrite[] = [];
  let finalClaims = initial;
  let didRewrite = false;

  if (contract.rewrite === "prune") {
    const pruned = await applyPruning(request.draft, initial);
    if (pruned.rewrites.length > 0) {
      didRewrite = true;
      rewrites = pruned.rewrites;
      finalText = pruned.finalText;
      finalClaims = evaluateDraft(finalText, sources, retrievalHash, timings?.observe);
    }
  }

  const allSupported = finalClaims.every((c) => c.verdict === "supported");
  const outcome = allSupported ? "release" : contract.delivery === "annotate" ? "annotated" : "blocked";

  const decision: Decision = {
    version: "pc-decision-1",
    contract_hash: contractHash,
    retrieval_hash: retrievalHash,
    as_of,
    original_hash: await hashUtf8(request.draft),
    final_hash: await hashUtf8(finalText),
    initial,
    final: finalClaims,
    rewrites,
    outcome,
  };

  const render_text = renderText(decision, finalText);
  const delHash = await deliveryHash(render_text);
  const decisionHash = await hashHex(J(decision));

  const payloads: EventPayload[] = [
    { kind: "accepted", request_hash: requestHash, contract_hash: contractHash, retrieval_hash: retrievalHash },
    { kind: "evaluated", revision: 0, claims_hash: await hashHex(J(initial)), draft_hash: await hashUtf8(request.draft) },
  ];
  if (didRewrite) {
    payloads.push({ kind: "rewritten", rewrites_hash: await hashHex(J(rewrites)), final_hash: decision.final_hash });
    payloads.push({
      kind: "evaluated",
      revision: 1,
      claims_hash: await hashHex(J(finalClaims)),
      draft_hash: await hashUtf8(finalText),
    });
  }
  payloads.push({
    kind: "delivery_prepared",
    decision_hash: decisionHash,
    delivery_hash: delHash,
    outcome,
  });

  return { decision, final_text: finalText, render_text, delivery_hash: delHash, payloads };
}
