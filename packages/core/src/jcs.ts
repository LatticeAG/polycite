import { U } from "./bytes.js";
import { invariant } from "./errors.js";

/**
 * RFC 8785 (JCS) canonicalization.
 * - object members sorted by UTF-16 code-unit order (Array.prototype.sort default);
 * - strings emitted with JSON.stringify escaping (the RFC 8785 string profile);
 * - numbers emitted with the ECMAScript Number::toString profile (required by
 *   RFC 8785); all in-scope business values are integers;
 * - arrays keep order.
 * Input must be a plain JSON value: scalars, arrays, and plain objects only.
 */
export function canonicalize(value: unknown): string {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      invariant(Number.isFinite(value), "non-finite number in canonicalization");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (value === null) return "null";
      if (Array.isArray(value)) {
        let out = "[";
        for (let i = 0; i < value.length; i++) {
          if (i) out += ",";
          out += canonicalize(value[i]);
        }
        return out + "]";
      }
      invariant(isPlainObject(value), "non-plain object in canonicalization");
      const keys = Object.keys(value as Record<string, unknown>).sort();
      let out = "{";
      for (let i = 0; i < keys.length; i++) {
        if (i) out += ",";
        out += JSON.stringify(keys[i]) + ":" + canonicalize((value as Record<string, unknown>)[keys[i]!]);
      }
      return out + "}";
    }
    default:
      throw new Error("non-JSON value in canonicalization");
  }
}

/** J(x): canonical JSON bytes. */
export function J(value: unknown): Uint8Array<ArrayBuffer> {
  return U(canonicalize(value));
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
