import { base64urlDecode, base64urlEncode, bytesEqual, concatBytes, hexDecode, hexEncode, U } from "./bytes.js";
import { invariant } from "./errors.js";
import type { Hash, KeyId, Signer } from "./types.js";

/**
 * Platform cryptography: WebCrypto SubtleCrypto (Node >=20 and Workers both
 * provide it). No homegrown primitives. Ed25519 verification is layered with
 * explicit canonicality and small-order checks before the platform verify.
 */

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto SubtleCrypto unavailable");
  return c.subtle;
};

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const d = await subtle().digest("SHA-256", data as BufferSource);
  return new Uint8Array(d);
}

export async function hashHex(data: Uint8Array): Promise<Hash> {
  return hexEncode(await sha256(data));
}

export async function hashUtf8(s: string): Promise<Hash> {
  return hashHex(U(s));
}

/* ---- Ed25519 strictness (RFC 8032 pure, canonical encodings) ---- */

/** Group order L = 2^252 + 27742317777372353535851937790883648493, little-endian. */
const ED25519_L = hexDecode("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010");
/** Field prime p = 2^255 - 19, little-endian. */
const ED25519_P = hexDecode("edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f");

/** Known small-order / non-canonical Ed25519 encodings (libsodium blocklist). */
const SMALL_ORDER: readonly string[] = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "c7176a703d4dd84fba3c0b760432106d00000000000000000000000000000080",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
];
const SMALL_ORDER_SET = new Set(SMALL_ORDER);

/** Little-endian 32-byte comparison: returns true iff a < b. */
function lt256(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 31; i >= 0; i--) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** y-coordinate of a compressed point is canonical iff y < p (top bit excluded). */
function canonicalPoint(enc: Uint8Array): boolean {
  const y = new Uint8Array(enc);
  y[31]! &= 0x7f;
  return lt256(y, ED25519_P);
}

export function isStrictEd25519Signature(sig: Uint8Array): boolean {
  if (sig.length !== 64) return false;
  const R = sig.subarray(0, 32);
  const S = sig.subarray(32, 64);
  if (!canonicalPoint(R)) return false;
  if (!lt256(S, ED25519_L)) return false;
  if (SMALL_ORDER_SET.has(hexEncode(R))) return false;
  return true;
}

export function isStrictEd25519PublicKey(pk: Uint8Array): boolean {
  if (pk.length !== 32) return false;
  if (!canonicalPoint(pk)) return false;
  if (SMALL_ORDER_SET.has(hexEncode(pk))) return false;
  return true;
}

export async function ed25519Verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (!isStrictEd25519PublicKey(publicKey)) return false;
  if (!isStrictEd25519Signature(signature)) return false;
  try {
    const key = await subtle().importKey("raw", publicKey as BufferSource, "Ed25519", false, ["verify"]);
    return await subtle().verify("Ed25519", key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

export async function ed25519Sign(seed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = concatBytes(hexDecode("302e020100300506032b657004220420"), seed);
  const key = await subtle().importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", false, ["sign"]);
  const sig = await subtle().sign("Ed25519", key, message as BufferSource);
  return new Uint8Array(sig);
}


export async function ed25519PublicFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = concatBytes(hexDecode("302e020100300506032b657004220420"), seed);
  const key = await subtle().importKey("pkcs8", pkcs8 as BufferSource, "Ed25519", true, ["sign"]);
  const jwk = await subtle().exportKey("jwk", key);
  invariant(typeof jwk.x === "string", "Ed25519 jwk missing public x");
  const raw = base64urlDecode(jwk.x);
  invariant(raw !== null && raw.length === 32, "Ed25519 public key must be 32 bytes");
  return raw;
}

/** Builds a Signer from a raw 32-byte Ed25519 seed. */
export function seedSigner(key_id: KeyId, seed: Uint8Array): Signer {
  if (seed.length !== 32) throw new TypeError("seed must be 32 bytes");
  return { key_id, sign: (message) => ed25519Sign(seed, message) };
}

/* ---- Signing domains ---- */

export const RETRIEVAL_DOMAIN = "PolyCite.retrieval.v1";
export const ENTRY_DOMAIN = "PolyCite.entry.v1";

export function domainMessage(domain: string, hashHexValue: Hash): Uint8Array {
  return concatBytes(U(domain + "\n"), hexDecode(hashHexValue));
}

/** Bearer-token digest: H(U(token)) over the 43-char canonical base64url text. */
export async function tokenDigest(token: string): Promise<Hash> {
  return hashHex(U(token));
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export function randomSeed(): Uint8Array {
  return randomBytes(32);
}

/** Canonical unpadded base64url of a 32-byte seed followed by one LF (file form). */
export function encodeSeed(seed: Uint8Array): string {
  if (seed.length !== 32) throw new TypeError("seed must be 32 bytes");
  return base64urlEncode(seed) + "\n";
}

/** Decodes a CLI key file or PC_SIGNING_SEED value; null on any non-canonical input. */
export function decodeSeed(text: string): Uint8Array | null {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  const seed = base64urlDecode(trimmed);
  if (seed === null || seed.length !== 32 || base64urlEncode(seed) !== trimmed) return null;
  return seed;
}

export { bytesEqual, base64urlDecode };
