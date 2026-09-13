import {
  computeDeterministic,
  err,
  hashHex,
  isPlainObject,
  J,
  renderText,
  runCheck,
  runSealRetrieval,
  verifyPackageInternal,
} from "@latticeag/polycite-core";
import type {
  BeforeSendInput,
  BeforeSendResult,
  CheckContext,
  JsonError,
  Package,
  RenderResult,
  Retrieval,
  RetrievalBody,
  Signer,
  TrustContext,
  ValidationResult,
  VerifyRequest,
  VerifyResult,
} from "@latticeag/polycite-core";

export function isJsonError(v: unknown): v is JsonError {
  return isPlainObject(v) && (v as Record<string, unknown>)["version"] === "pc-error-1";
}

/** Validates and seals a signed retrieval snapshot. The caller is the trusted
 *  retrieval adapter; the generator never receives the signer capability. */
export async function sealRetrieval(
  body: RetrievalBody,
  signer: Signer,
): Promise<Retrieval | JsonError> {
  return runSealRetrieval(body, signer);
}

/** Runs one verification attempt under the trusted context. */
export async function check(
  request: VerifyRequest,
  context: CheckContext,
): Promise<VerifyResult | JsonError> {
  return runCheck(request, context);
}

/** §11 package validation against an externally pinned trust context. */
export async function verifyPackage(
  value: Package,
  trust: TrustContext,
): Promise<ValidationResult> {
  return verifyPackageInternal(value, trust);
}

/** Delivery-time rendering. Requires purpose="delivery"; a historical purpose
 *  returns EXPIRED_RECEIPT rather than bypassing the delivery gate. A valid
 *  blocked package yields RenderResult with null text, not an exception. */
export async function render(
  value: Package,
  trust: TrustContext,
): Promise<RenderResult | JsonError> {
  if (!isPlainObject(trust)) throw new TypeError("trust must be a plain object");
  if (trust.purpose !== "delivery") return err("EXPIRED_RECEIPT", "/result/decision/as_of");
  const v = await verifyPackageInternal(value, trust);
  if (!v.valid) return v.failure;
  const pkg = value as Package;
  const text = renderText(pkg.result.decision, pkg.result.final_text);
  return {
    outcome: pkg.result.decision.outcome,
    content_type: "text/plain; charset=utf-8",
    text,
  };
}

/** PolyBrain response-boundary hook: constructs the plain English request,
 *  checks, independently validates the package, then renders. No error branch
 *  ever returns the original draft. */
export async function beforeSend(
  input: BeforeSendInput,
  context: CheckContext,
  trust: TrustContext,
): Promise<BeforeSendResult | JsonError> {
  if (!isPlainObject(input)) throw new TypeError("input must be a plain object");
  if (typeof input.draft !== "string") throw new TypeError("input.draft must be a string");
  const request: VerifyRequest = {
    version: "pc-request-1",
    run_id: input.run_id,
    contract_hash: await hashHex(J(context.contract)),
    format: "plain",
    language: "en",
    draft: input.draft,
    retrieval: input.retrieval,
  };
  const result = await runCheck(request, context);
  if (isJsonError(result)) return result;
  const pkg: Package = { version: "pc-package-1", request, result };
  const valid = await verifyPackageInternal(pkg, trust);
  if (!valid.valid) return valid.failure;
  const delivery = await render(pkg, trust);
  if (isJsonError(delivery)) return delivery;
  return { package: pkg, delivery };
}

/** Canonical package bytes (RFC 8785). Does not itself assert validity. */
export function encodePackage(value: Package): Uint8Array {
  return J(value);
}

/** Recompute the deterministic decision for inspection tooling. */
export async function replayDecision(
  value: Package,
): Promise<{ decisionHash: string; finalText: string }> {
  const det = await computeDeterministic(
    value.request,
    value.result.contract,
    value.result.decision.as_of,
  );
  return { decisionHash: await hashHex(J(det.decision)), finalText: det.final_text };
}
