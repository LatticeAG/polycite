import { randomBytes } from "./crypto.js";
import type { BatchId, EntryId, KeyId, RunId, SourceId, TenantId } from "./types.js";

/** Locked prefix + exactly 21 chars from A-Za-z0-9_- (nanoid alphabet). */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const ID_BODY = /^[A-Za-z0-9_-]{21}$/;

export function isId(value: unknown, prefix: string): boolean {
  return (
    typeof value === "string" &&
    value.length === prefix.length + 21 &&
    value.startsWith(prefix) &&
    ID_BODY.test(value.slice(prefix.length))
  );
}

export const isRunId = (v: unknown): v is RunId => isId(v, "pcr_");
export const isSourceId = (v: unknown): v is SourceId => isId(v, "pcs_");
export const isBatchId = (v: unknown): v is BatchId => isId(v, "pcb_");
export const isEntryId = (v: unknown): v is EntryId => isId(v, "pce_");
export const isKeyId = (v: unknown): v is KeyId => isId(v, "pck_");
export const isTenantId = (v: unknown): v is TenantId => isId(v, "pct_");

/** Cryptographically secure nanoid with the fixed alphabet (byte & 63 mask). */
export function nanoid(): string {
  // 64-char alphabet: rejection-free sampling via 6-bit mask.
  const out: string[] = new Array(21);
  const buf = randomBytes(21);
  for (let i = 0; i < 21; i++) out[i] = ALPHABET[buf[i]! & 63]!;
  return out.join("");
}

export function newRunId(): RunId {
  return "pcr_" + nanoid();
}

export function newEntryId(): EntryId {
  return "pce_" + nanoid();
}

export function newKeyId(): KeyId {
  return "pck_" + nanoid();
}

export function newSourceId(): SourceId {
  return "pcs_" + nanoid();
}

/** Production entry-ID generator: fresh nanoids, pce_ prefix. */
export function nanoidEntryIds(): () => EntryId {
  return () => newEntryId();
}
