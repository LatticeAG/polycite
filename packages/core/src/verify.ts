import { base64urlDecode } from "./bytes.js";
import { domainMessage, ed25519Verify, hashHex, ENTRY_DOMAIN } from "./crypto.js";
import { computeDeterministic } from "./decision.js";
import { err, Fail } from "./errors.js";
import { validateRequestIntegrity } from "./integrity.js";
import { isPlainObject, J } from "./jcs.js";
import { isTenantId } from "./ids.js";
import { isValidTime, timeToEpochSeconds } from "./time.js";
import { vKeyRecord, vPackage } from "./validate.js";
import { canonicalize } from "./jcs.js";
import type {
  Entry,
  EventPayload,
  JsonError,
  KeyRecord,
  Package,
  TrustContext,
  ValidationResult,
} from "./types.js";

/** 60 s delivery future-skew and 300 s receipt delivery lifetime (§6.1). */
const DELIVERY_SKEW_S = 60;
const RECEIPT_LIFETIME_S = 300;

function checkTrust(trust: TrustContext): void {
  if (!isPlainObject(trust)) throw new TypeError("trust must be a plain object");
  if (!isTenantId(trust.tenant_id)) throw new TypeError("trust.tenant_id is not a pct_ id");
  if (typeof trust.contract_hash !== "string" || !/^[0-9a-f]{64}$/.test(trust.contract_hash))
    throw new TypeError("trust.contract_hash is not a Hash");
  if (!Array.isArray(trust.receipt_keys) || trust.receipt_keys.length < 1 || trust.receipt_keys.length > 16)
    throw new TypeError("trust.receipt_keys must have 1-16 entries");
  trust.receipt_keys.forEach((k, i) => {
    try {
      vKeyRecord(k, `/receipt_keys/${i}`);
    } catch (e) {
      throw new TypeError(`trust.receipt_keys[${i}] invalid: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  if (!isValidTime(trust.now)) throw new TypeError("trust.now is not a valid Time");
  if (trust.purpose !== "delivery" && trust.purpose !== "historical")
    throw new TypeError("trust.purpose must be delivery or historical");
}

/**
 * §11 package validation: strict schema, expected tenant/contract, request
 * integrity, chain structure/hashes, receipt key trust/signatures, time,
 * deterministic reconstruction, release binding.
 */
export async function verifyPackageInternal(
  value: unknown,
  trust: TrustContext,
): Promise<ValidationResult> {
  checkTrust(trust);
  try {
    return await verifyAttempt(value, trust);
  } catch (e) {
    if (e instanceof Fail) return { valid: false, failure: e.json };
    return { valid: false, failure: err("INTERNAL_UNAVAILABLE") };
  }
}

async function verifyAttempt(value: unknown, trust: TrustContext): Promise<ValidationResult> {
  // 1. Strict schema (nested paths appear naturally: /request/…, /result/…).
  vPackage(value, "");
  const pkg = value as unknown as Package;
  const { request, result } = pkg;
  const decision = result.decision;
  const audit = result.audit;
  const asOfSec = timeToEpochSeconds(decision.as_of);
  const nowSec = timeToEpochSeconds(trust.now);

  // 2. Expected tenant and contract.
  if (result.tenant_id !== trust.tenant_id) throw new Fail("AUDIENCE_MISMATCH", "/result/tenant_id");
  const contractHash = await hashHex(J(result.contract));
  if (contractHash !== trust.contract_hash) throw new Fail("CONTRACT_MISMATCH", "/result/contract");

  // 3. Request integrity: run binding, request hash, embedded request checks.
  if (result.run_id !== request.run_id) throw new Fail("PACKAGE_INVALID", "/result/run_id");
  if (result.request_hash !== (await hashHex(J(request))))
    throw new Fail("PACKAGE_INVALID", "/result/request_hash");
  await validateRequestIntegrity(request, result.contract, result.tenant_id, decision.as_of, "/request");

  // 4. Chain structure and hashes (all structural checks before signatures).
  const seenEntryIds = new Set<string>();
  for (let i = 0; i < audit.length; i++) {
    const e: Entry = audit[i]!;
    const p = `/result/audit/${i}`;
    const expectedPrev = i === 0 ? null : audit[i - 1]!.hash;
    if (e.body.previous_hash !== expectedPrev)
      throw new Fail("CHAIN_INVALID", `${p}/body/previous_hash`);
    if (e.body.sequence !== i) throw new Fail("CHAIN_INVALID", `${p}/body/sequence`);
    if (seenEntryIds.has(e.body.entry_id))
      throw new Fail("CHAIN_INVALID", `${p}/body/entry_id`);
    seenEntryIds.add(e.body.entry_id);
    if (e.hash !== (await hashHex(J(e.body)))) throw new Fail("CHAIN_INVALID", `${p}/hash`);
    if (e.body.tenant_id !== result.tenant_id)
      throw new Fail("CHAIN_INVALID", `${p}/body/tenant_id`);
    if (e.body.run_id !== result.run_id) throw new Fail("CHAIN_INVALID", `${p}/body/run_id`);
    if (e.body.at !== decision.as_of) throw new Fail("CHAIN_INVALID", `${p}/body/at`);
    if (i > 0 && e.key_id !== audit[0]!.key_id) throw new Fail("CHAIN_INVALID", `${p}/key_id`);
  }

  const kinds = audit.map((e) => e.body.payload.kind);
  const validShape =
    (kinds.length === 3 &&
      kinds[0] === "accepted" &&
      kinds[1] === "evaluated" &&
      (audit[1]!.body.payload as { revision: number }).revision === 0 &&
      kinds[2] === "delivery_prepared") ||
    (kinds.length === 5 &&
      kinds[0] === "accepted" &&
      kinds[1] === "evaluated" &&
      (audit[1]!.body.payload as { revision: number }).revision === 0 &&
      kinds[2] === "rewritten" &&
      kinds[3] === "evaluated" &&
      (audit[3]!.body.payload as { revision: number }).revision === 1 &&
      kinds[4] === "delivery_prepared");
  if (!validShape) throw new Fail("CHAIN_INVALID", "/result/audit");
  if (result.head_hash !== audit[audit.length - 1]!.hash)
    throw new Fail("CHAIN_INVALID", "/result/head_hash");

  // 5. Receipt key trust and signatures.
  for (let i = 0; i < audit.length; i++) {
    const e = audit[i]!;
    const p = `/result/audit/${i}`;
    const kr: KeyRecord | undefined = trust.receipt_keys.find((k) => k.key_id === e.key_id);
    const validAt =
      kr !== undefined &&
      !kr.revoked &&
      timeToEpochSeconds(kr.not_before) <= asOfSec &&
      asOfSec < timeToEpochSeconds(kr.not_after);
    if (!validAt) throw new Fail("UNKNOWN_RECEIPT_KEY", `${p}/key_id`);
    const pub = base64urlDecode(kr!.public_key);
    const sig = base64urlDecode(e.signature);
    if (pub === null || sig === null || !(await ed25519Verify(pub, domainMessage(ENTRY_DOMAIN, e.hash), sig)))
      throw new Fail("BAD_RECEIPT_SIGNATURE", `${p}/signature`);
  }

  // 6. Time: delivery window for delivery purpose; freshness is reported always.
  const fresh = asOfSec <= nowSec + DELIVERY_SKEW_S && nowSec < asOfSec + RECEIPT_LIFETIME_S;
  if (trust.purpose === "delivery" && !fresh)
    throw new Fail("EXPIRED_RECEIPT", "/result/decision/as_of");

  // 7+8. Deterministic reconstruction and release binding.
  let det;
  try {
    det = await computeDeterministic(request, result.contract, decision.as_of);
  } catch (e) {
    if (e instanceof Fail) throw new Fail(e.json.error.code, "/request" + e.json.error.path);
    throw e;
  }
  if (canonicalize(det.decision) !== canonicalize(decision))
    throw new Fail("PACKAGE_INVALID", "/result/decision");
  if (det.final_text !== result.final_text) throw new Fail("RELEASE_MISMATCH", "/result/final_text");

  if (det.payloads.length !== audit.length) throw new Fail("CHAIN_INVALID", "/result/audit");
  for (let i = 0; i < audit.length; i++) {
    const expected = det.payloads[i]!;
    const actual = audit[i]!.body.payload;
    for (const key of Object.keys(expected) as (keyof EventPayload)[]) {
      // per-field compare for exact paths
      const ok = canonicalize((expected as Record<string, unknown>)[key]) === canonicalize((actual as Record<string, unknown>)[key]);
      if (!ok) {
        const path = `/result/audit/${i}/body/payload/${key}`;
        if ((key as string) === "delivery_hash" && i === audit.length - 1)
          throw new Fail("RELEASE_MISMATCH", path);
        throw new Fail("CHAIN_INVALID", path);
      }
    }
  }

  return {
    valid: true,
    fresh,
    head_hash: result.head_hash,
    decision_hash: await hashHex(J(decision)),
    outcome: decision.outcome,
  };
}

export { type JsonError };
