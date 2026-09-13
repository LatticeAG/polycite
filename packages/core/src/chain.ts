import { base64urlEncode } from "./bytes.js";
import { domainMessage, hashHex } from "./crypto.js";
import { invariant } from "./errors.js";
import { isEntryId } from "./ids.js";
import { J } from "./jcs.js";
import { ENTRY_DOMAIN } from "./crypto.js";
import type { Entry, EntryBody, EntryId, EventPayload, KeyId, RunId, Signer, TenantId, Time } from "./types.js";

/** Builds and signs the per-run audit chain (genesis sequence 0 / null). */
export async function buildChain(
  payloads: EventPayload[],
  opts: {
    tenant_id: TenantId;
    run_id: RunId;
    at: Time;
    signer: Signer;
    next_entry_id: () => EntryId;
    observeSign?: ((ms: number) => void) | undefined;
  },
): Promise<Entry[]> {
  const audit: Entry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < payloads.length; i++) {
    const entry_id = opts.next_entry_id();
    if (!isEntryId(entry_id)) throw new Error("next_entry_id returned a malformed id");
    if (seen.has(entry_id)) throw new Error("next_entry_id returned a duplicate id");
    seen.add(entry_id);
    const body: EntryBody = {
      version: "pc-entry-1",
      entry_id,
      tenant_id: opts.tenant_id,
      run_id: opts.run_id,
      sequence: i,
      at: opts.at,
      previous_hash: i === 0 ? null : audit[i - 1]!.hash,
      payload: payloads[i]!,
    };
    const hash = await hashHex(J(body));
    const s0 = performance.now();
    const sigBytes = await opts.signer.sign(domainMessage(ENTRY_DOMAIN, hash));
    opts.observeSign?.(performance.now() - s0);
    invariant(sigBytes.length === 64, "signer must return a raw 64-byte Ed25519 signature");
    audit.push({ body, hash, key_id: opts.signer.key_id as KeyId, signature: base64urlEncode(sigBytes) });
  }
  return audit;
}
