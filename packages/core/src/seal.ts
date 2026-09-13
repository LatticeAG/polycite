import { base64urlEncode, utf8Length } from "./bytes.js";
import { domainMessage, hashHex, hashUtf8, RETRIEVAL_DOMAIN } from "./crypto.js";
import { err, Fail } from "./errors.js";
import { isPlainObject, J } from "./jcs.js";
import { hasDisallowedControl, isStructuralNonText } from "./text.js";
import { vRetrievalBody } from "./validate.js";
import type { JsonError, Retrieval, RetrievalBody, Signer } from "./types.js";

const MAX_SOURCE_SUM = 262144;

/**
 * sealRetrieval: validates the RetrievalBody (closed shape, source order,
 * text-only admission, aggregate limits), requires each declared content_hash
 * to equal H(U(text)), then signs H(J(body)) under PolyCite.retrieval.v1 with
 * the caller's signer. Error paths are body-relative (/sources/i/…).
 */
export async function runSealRetrieval(body: unknown, signer: Signer): Promise<Retrieval | JsonError> {
  if (!isPlainObject(body)) throw new TypeError("body must be a plain object");
  if (!isPlainObject(signer) || typeof signer.sign !== "function")
    throw new TypeError("signer must be {key_id, sign}");
  try {
    vRetrievalBody(body, "");
    const b = body as unknown as RetrievalBody;
    for (let i = 1; i < b.sources.length; i++) {
      if (!(b.sources[i - 1]!.source_id < b.sources[i]!.source_id))
        throw new Fail("SCHEMA_INVALID", `/sources/${i}/source_id`);
    }
    let sum = 0;
    for (const s of b.sources) sum += utf8Length(s.text);
    if (sum > MAX_SOURCE_SUM) throw new Fail("LIMIT_EXCEEDED", "/sources");
    for (let i = 0; i < b.sources.length; i++) {
      const s = b.sources[i]!;
      if (s.kind !== "text") throw new Fail("NON_TEXT_INPUT", `/sources/${i}/kind`);
    }
    for (let i = 0; i < b.sources.length; i++) {
      const s = b.sources[i]!;
      if (hasDisallowedControl(s.text)) throw new Fail("DISALLOWED_CONTROL", `/sources/${i}/text`);
    }
    for (let i = 0; i < b.sources.length; i++) {
      const s = b.sources[i]!;
      if (isStructuralNonText(s.text)) throw new Fail("NON_TEXT_INPUT", `/sources/${i}/text`);
    }
    for (let i = 0; i < b.sources.length; i++) {
      const s = b.sources[i]!;
      if (s.content_hash !== (await hashUtf8(s.text)))
        throw new Fail("BAD_CONTENT_HASH", `/sources/${i}/content_hash`);
    }
    const hash = await hashHex(J(b));
    const sig = await signer.sign(domainMessage(RETRIEVAL_DOMAIN, hash));
    if (!(sig instanceof Uint8Array) || sig.length !== 64)
      return err("INTERNAL_UNAVAILABLE");
    return { body: b, hash, key_id: signer.key_id, signature: base64urlEncode(sig) };
  } catch (e) {
    if (e instanceof Fail) return e.json;
    return err("INTERNAL_UNAVAILABLE");
  }
}
