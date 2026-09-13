import { buildChain } from "./chain.js";
import { computeDeterministic } from "./decision.js";
import { err, Fail, invariant } from "./errors.js";
import { isPlainObject, J } from "./jcs.js";
import { isKeyId, isTenantId } from "./ids.js";
import { isValidTime, timeToEpochSeconds } from "./time.js";
import { vContract, vKeyRecord, vVerifyRequest } from "./validate.js";
import { hashHex } from "./crypto.js";
import { validateRequestIntegrity } from "./integrity.js";
import { verifyPackageInternal } from "./verify.js";
import type {
  CheckContext,
  JsonError,
  VerifyRequest,
  VerifyResult,
} from "./types.js";

const DEFAULT_DEADLINE_MS = 2000;

/** Programmer-facing context validation: violations throw TypeError. */
function checkContext(ctx: CheckContext): void {
  if (!isPlainObject(ctx)) throw new TypeError("context must be a plain object");
  if (!isTenantId(ctx.tenant_id)) throw new TypeError("context.tenant_id is not a pct_ id");
  try {
    vContract(ctx.contract, "/contract");
  } catch (e) {
    throw new TypeError(`context.contract invalid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isValidTime(ctx.as_of)) throw new TypeError("context.as_of is not a valid Time");
  if (!isPlainObject(ctx.signer) || !isKeyId(ctx.signer.key_id) || typeof ctx.signer.sign !== "function")
    throw new TypeError("context.signer must be {key_id: pck_…, sign: fn}");
  if (!Array.isArray(ctx.receipt_keys) || ctx.receipt_keys.length < 1 || ctx.receipt_keys.length > 16)
    throw new TypeError("context.receipt_keys must have 1-16 entries");
  ctx.receipt_keys.forEach((k, i) => {
    try {
      vKeyRecord(k, `/receipt_keys/${i}`);
    } catch (e) {
      throw new TypeError(`context.receipt_keys[${i}] invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (typeof ctx.next_entry_id !== "function") throw new TypeError("context.next_entry_id must be a function");
  if (!ctx.signal || typeof ctx.signal.aborted !== "boolean") throw new TypeError("context.signal must expose .aborted");
  if (ctx.monotonic_ms !== undefined && typeof ctx.monotonic_ms !== "function")
    throw new TypeError("context.monotonic_ms must be a function");
  if (ctx.deadline_ms !== undefined && (typeof ctx.deadline_ms !== "number" || ctx.deadline_ms <= 0))
    throw new TypeError("context.deadline_ms must be a positive number");
}

interface Attempt {
  monotonic: () => number;
  start: number;
  deadlineMs: number;
}

function consultDeadline(a: Attempt): void {
  if (a.monotonic() - a.start > a.deadlineMs) throw new Fail("DEADLINE_EXCEEDED");
}

function consultAbort(ctx: CheckContext): void {
  if (ctx.signal.aborted) throw new Fail("INTERNAL_UNAVAILABLE");
}

/**
 * The full §4.1 validation order and §7 state machine for one verification
 * attempt. Returns a VerifyResult or one JsonError; Fail is converted.
 */
export async function runCheck(request: unknown, context: CheckContext): Promise<VerifyResult | JsonError> {
  checkContext(context);
  try {
    if (!isPlainObject(request)) throw new Fail("SCHEMA_INVALID", "");
    return await checkAttempt(request as unknown as VerifyRequest, context);
  } catch (e) {
    if (e instanceof Fail) return e.json;
    return err("INTERNAL_UNAVAILABLE");
  }
}

async function checkAttempt(request: VerifyRequest, ctx: CheckContext): Promise<VerifyResult> {
  const attempt: Attempt = {
    monotonic: ctx.monotonic_ms ?? (() => performance.now()),
    start: 0,
    deadlineMs: ctx.deadline_ms ?? DEFAULT_DEADLINE_MS,
  };
  attempt.start = attempt.monotonic();

  // NEW -> VALIDATING: admission consults the abort signal first.
  consultAbort(ctx);
  consultDeadline(attempt);

  // Signer capability must correspond to a nonrevoked receipt key valid at as_of.
  const asOfSec = timeToEpochSeconds(ctx.as_of);
  const signerKey = ctx.receipt_keys.find((k) => k.key_id === ctx.signer.key_id);
  if (
    !signerKey ||
    signerKey.revoked ||
    !(timeToEpochSeconds(signerKey.not_before) <= asOfSec && asOfSec < timeToEpochSeconds(signerKey.not_after))
  ) {
    throw new Fail("INTERNAL_UNAVAILABLE");
  }

  // Step 2: schema shape, primitive bounds, protocol versions.
  vVerifyRequest(request, "");

  // Steps 3–5: semantic integrity against the effective contract.
  await validateRequestIntegrity(request, ctx.contract, ctx.tenant_id, ctx.as_of, "");

  // Steps 6+7: evaluation (candidate/atom limits and coverage inside), optional
  // pruning, final evaluation, rendering preparation, audit signing, and
  // complete package self-verification.
  const det = await computeDeterministic(request, ctx.contract, ctx.as_of, ctx.timings);

  // Abort consult and deadline before any signer call.
  consultAbort(ctx);
  consultDeadline(attempt);

  const audit = await buildChain(det.payloads, {
    tenant_id: ctx.tenant_id,
    run_id: request.run_id,
    at: ctx.as_of,
    signer: ctx.signer,
    next_entry_id: ctx.next_entry_id,
    observeSign: ctx.timings ? (ms) => ctx.timings!.observe("pc_sign_ms", ms) : undefined,
  });

  const result: VerifyResult = {
    version: "pc-result-1",
    run_id: request.run_id,
    tenant_id: ctx.tenant_id,
    request_hash: await hashHex(J(request)),
    contract: ctx.contract,
    decision: det.decision,
    final_text: det.final_text,
    audit,
    head_hash: audit[audit.length - 1]!.hash,
  };

  consultDeadline(attempt);

  // Complete package self-verification before any releasable content returns.
  const pkg = { version: "pc-package-1" as const, request, result };
  const self = await verifyPackageInternal(pkg, {
    tenant_id: ctx.tenant_id,
    contract_hash: det.decision.contract_hash,
    receipt_keys: ctx.receipt_keys,
    now: ctx.as_of,
    purpose: "historical",
  });
  invariant(self.valid, "package self-verification failed");

  return result;
}
