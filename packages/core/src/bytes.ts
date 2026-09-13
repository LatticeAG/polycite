/** Byte utilities: strict UTF-8, lowercase hex, canonical unpadded base64url. */

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });
const laxDecoder = new TextDecoder("utf-8", { fatal: false });

export function U(s: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(s);
}

/** Strict UTF-8 decode; throws on malformed input. */
export function utf8Decode(bytes: Uint8Array): string {
  return fatalDecoder.decode(bytes);
}

/** Lossy decode used only for diagnostics that must not throw. */
export function utf8DecodeLossy(bytes: Uint8Array): string {
  return laxDecoder.decode(bytes);
}

export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}

const HEX = "0123456789abcdef";

export function hexEncode(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function hexDecode(s: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(s) || s.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64U = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64U_REV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64U.charCodeAt(i)] = i;
  return t;
})();

export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]! + B64U[n & 63]!;
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i]! << 16;
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]!;
  } else if (rem === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64U[(n >> 18) & 63]! + B64U[(n >> 12) & 63]! + B64U[(n >> 6) & 63]!;
  }
  return out;
}

/** Decodes canonical unpadded base64url; returns null for any non-canonical input. */
export function base64urlDecode(s: string): Uint8Array | null {
  if (s.length === 0) return new Uint8Array(0);
  if (s.length % 4 === 1) return null;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 127 || B64U_REV[c]! < 0) return null;
  }
  const fullGroups = Math.floor(s.length / 4);
  const tail = s.length % 4;
  const out = new Uint8Array(fullGroups * 3 + (tail === 2 ? 1 : tail === 3 ? 2 : 0));
  let o = 0;
  for (let g = 0; g < fullGroups; g++) {
    const i = g * 4;
    const n =
      (B64U_REV[s.charCodeAt(i)]! << 18) |
      (B64U_REV[s.charCodeAt(i + 1)]! << 12) |
      (B64U_REV[s.charCodeAt(i + 2)]! << 6) |
      B64U_REV[s.charCodeAt(i + 3)]!;
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
    out[o++] = n & 255;
  }
  if (tail === 2) {
    const n = (B64U_REV[s.charCodeAt(s.length - 2)]! << 18) | (B64U_REV[s.charCodeAt(s.length - 1)]! << 12);
    out[o++] = (n >> 16) & 255;
  } else if (tail === 3) {
    const i = s.length - 3;
    const n =
      (B64U_REV[s.charCodeAt(i)]! << 18) |
      (B64U_REV[s.charCodeAt(i + 1)]! << 12) |
      (B64U_REV[s.charCodeAt(i + 2)]! << 6);
    out[o++] = (n >> 16) & 255;
    out[o++] = (n >> 8) & 255;
  }
  return out;
}

/** Canonical base64url: decodes to exactly `len` bytes and re-encodes to the input. */
export function isCanonicalBase64url(s: string, len: number): boolean {
  const d = base64urlDecode(s);
  return d !== null && d.length === len && base64urlEncode(d) === s;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
