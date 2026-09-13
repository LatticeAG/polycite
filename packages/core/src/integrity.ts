import { base64urlDecode, U, utf8Length } from "./bytes.js";
import { domainMessage, ed25519Verify, hashHex, hashUtf8, RETRIEVAL_DOMAIN } from "./crypto.js";
import { Fail } from "./errors.js";
import { J } from "./jcs.js";
import { timeToEpochSeconds } from "./time.js";
import { hasDisallowedControl, isAsciiWhitespace, isStructuralNonText } from "./text.js";
import type { Contract, TenantId, Time, VerifyRequest } from "./types.js";

const MAX_SOURCE_SUM = 262144;

/**
 * §4.1 steps 3–5: contract hash, audience, source order, aggregate limits,
 * nonempty draft; text-only admission; content/retrieval hashes; configured
 * signer, authority scope, signature, key validity, freshness. `prefix` is ""
 * for request validation and "/request" for embedded-package validation.
 */
export async function validateRequestIntegrity(
  request: VerifyRequest,
  contract: Contract,
  tenant_id: TenantId,
  as_of: Time,
  prefix: string,
): Promise<void> {
  const P = (p: string) => prefix + p;
  const retrieval = request.retrieval;
  const body = retrieval.body;
  const asOfSec = timeToEpochSeconds(as_of);

  // Step 3.
  const contractHash = await hashHex(J(contract));
  if (request.contract_hash !== contractHash) throw new Fail("CONTRACT_MISMATCH", P("/contract_hash"));
  if (body.audience !== tenant_id) throw new Fail("AUDIENCE_MISMATCH", P("/retrieval/body/audience"));
  for (let i = 1; i < body.sources.length; i++) {
    if (!(body.sources[i - 1]!.source_id < body.sources[i]!.source_id))
      throw new Fail("SCHEMA_INVALID", P(`/retrieval/body/sources/${i}/source_id`));
  }
  let sum = 0;
  for (const s of body.sources) sum += utf8Length(s.text);
  if (sum > MAX_SOURCE_SUM) throw new Fail("LIMIT_EXCEEDED", P("/retrieval/body/sources"));
  const draftBytes = U(request.draft);
  if (draftBytes.length === 0 || draftBytes.every((b) => isAsciiWhitespace(b)))
    throw new Fail("EMPTY_DRAFT", P("/draft"));

  // Step 4: declared format, source kinds, disallowed controls, structural non-text.
  if (request.format !== "plain") throw new Fail("NON_TEXT_INPUT", P("/format"));
  for (let i = 0; i < body.sources.length; i++) {
    if (body.sources[i]!.kind !== "text")
      throw new Fail("NON_TEXT_INPUT", P(`/retrieval/body/sources/${i}/kind`));
  }
  if (hasDisallowedControl(request.draft)) throw new Fail("DISALLOWED_CONTROL", P("/draft"));
  for (let i = 0; i < body.sources.length; i++) {
    if (hasDisallowedControl(body.sources[i]!.text))
      throw new Fail("DISALLOWED_CONTROL", P(`/retrieval/body/sources/${i}/text`));
  }
  if (isStructuralNonText(request.draft)) throw new Fail("NON_TEXT_INPUT", P("/draft"));
  for (let i = 0; i < body.sources.length; i++) {
    if (isStructuralNonText(body.sources[i]!.text))
      throw new Fail("NON_TEXT_INPUT", P(`/retrieval/body/sources/${i}/text`));
  }

  // Step 5.
  for (let i = 0; i < body.sources.length; i++) {
    const s = body.sources[i]!;
    if (s.content_hash !== (await hashUtf8(s.text)))
      throw new Fail("BAD_CONTENT_HASH", P(`/retrieval/body/sources/${i}/content_hash`));
  }
  if (retrieval.hash !== (await hashHex(J(body))))
    throw new Fail("BAD_RETRIEVAL_HASH", P("/retrieval/hash"));
  const rkey = contract.retrieval_keys.find((k) => k.key_id === retrieval.key_id);
  if (!rkey) throw new Fail("UNTRUSTED_RETRIEVER", P("/retrieval/key_id"));
  for (let i = 0; i < body.sources.length; i++) {
    if (!rkey.authorities.includes(body.sources[i]!.authority))
      throw new Fail("UNTRUSTED_RETRIEVER", P(`/retrieval/body/sources/${i}/authority`));
  }
  const pub = base64urlDecode(rkey.public_key);
  const sig = base64urlDecode(retrieval.signature);
  if (
    pub === null ||
    sig === null ||
    !(await ed25519Verify(pub, domainMessage(RETRIEVAL_DOMAIN, retrieval.hash), sig))
  )
    throw new Fail("BAD_RETRIEVAL_SIGNATURE", P("/retrieval/signature"));
  const retrievedSec = timeToEpochSeconds(body.retrieved_at);
  const nb = timeToEpochSeconds(rkey.not_before);
  const na = timeToEpochSeconds(rkey.not_after);
  if (rkey.revoked || !(nb <= asOfSec && asOfSec < na) || !(nb <= retrievedSec && retrievedSec < na))
    throw new Fail("UNTRUSTED_RETRIEVER", P("/retrieval/key_id"));
  if (retrievedSec > asOfSec + contract.future_skew_s)
    throw new Fail("FUTURE_RETRIEVAL", P("/retrieval/body/retrieved_at"));
  if (asOfSec - retrievedSec > contract.max_age_s)
    throw new Fail("STALE_RETRIEVAL", P("/retrieval/body/retrieved_at"));
}
