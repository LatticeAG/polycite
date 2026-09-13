import {
  ed25519PublicFromSeed,
  isKeyId,
  newEntryId,
  newKeyId,
  seedSigner,
} from "@latticeag/polycite-core";
import type { EntryId, KeyId, Signer } from "@latticeag/polycite-core";

export { decodeSeed, encodeSeed as encodeSeedFile } from "@latticeag/polycite-core";

/** Local receipt/retrieval signer built from a raw seed. Private bytes stay
 *  inside the closure; adapters never see key material. */
export async function localSigner(key_id: KeyId, seed: Uint8Array): Promise<Signer> {
  if (!isKeyId(key_id)) throw new TypeError("key_id must be a pck_ id");
  const derived = await ed25519PublicFromSeed(seed);
  void derived; // correspondence is enforced via configured KeyRecord lookups
  return seedSigner(key_id, seed);
}

export async function derivePublicKey(seed: Uint8Array): Promise<Uint8Array> {
  if (seed.length !== 32) throw new TypeError("seed must be 32 bytes");
  return ed25519PublicFromSeed(seed);
}

/** Production entry-ID generator: fresh nanoids, pce_ prefix. */
export function nanoidEntryIds(): () => EntryId {
  return () => newEntryId();
}

export function generateKeyId(): KeyId {
  return newKeyId();
}
