import type { ErrorCode, JsonError } from "@latticeag/polycite-core";

/** §12 exit-code mapping. */

const EXIT_BY_CODE: Record<ErrorCode, number> = {
  BAD_JSON: 20,
  SCHEMA_INVALID: 20,
  UNSUPPORTED_VERSION: 20,
  UNSUPPORTED_MEDIA_TYPE: 20,
  UNAUTHENTICATED: 20,
  FORBIDDEN: 20,
  NOT_FOUND: 20,
  METHOD_NOT_ALLOWED: 20,
  TOO_LARGE: 20,
  EMPTY_DRAFT: 20,
  DISALLOWED_CONTROL: 20,
  NON_TEXT_INPUT: 20,
  LIMIT_EXCEEDED: 20,
  STALE_RETRIEVAL: 20,
  FUTURE_RETRIEVAL: 20,
  CONTRACT_MISMATCH: 21,
  AUDIENCE_MISMATCH: 21,
  BAD_CONTENT_HASH: 21,
  BAD_RETRIEVAL_HASH: 21,
  BAD_RETRIEVAL_SIGNATURE: 21,
  UNTRUSTED_RETRIEVER: 21,
  PACKAGE_INVALID: 21,
  UNKNOWN_RECEIPT_KEY: 21,
  BAD_RECEIPT_SIGNATURE: 21,
  CHAIN_INVALID: 21,
  EXPIRED_RECEIPT: 21,
  RELEASE_MISMATCH: 21,
  RATE_LIMITED: 22,
  DEADLINE_EXCEEDED: 22,
  INTERNAL_UNAVAILABLE: 22,
};

export function exitForError(e: JsonError): number {
  return EXIT_BY_CODE[e.error.code] ?? 24;
}

/** Batch exit precedence: 24 > 23 > 22 > 21 > 20 > 11 > 10 > 0. */
export function batchExit(itemExits: number[]): number {
  for (const code of [24, 23, 22, 21, 20, 11, 10]) {
    if (itemExits.includes(code)) return code;
  }
  return 0;
}

export function outcomeExit(outcome: "release" | "annotated" | "blocked"): number {
  return outcome === "annotated" ? 10 : outcome === "blocked" ? 11 : 0;
}
