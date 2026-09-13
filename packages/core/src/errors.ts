import type { ErrorCode, JsonError } from "./types.js";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "RATE_LIMITED",
  "DEADLINE_EXCEEDED",
  "INTERNAL_UNAVAILABLE",
]);

export function err(code: ErrorCode, path = ""): JsonError {
  return { version: "pc-error-1", error: { code, path, retryable: RETRYABLE.has(code) } };
}

/** Internal non-local control flow carrying a wire JsonError. */
export class Fail extends Error {
  readonly json: JsonError;
  constructor(code: ErrorCode, path = "") {
    super(`${code} ${path}`);
    this.name = "Fail";
    this.json = err(code, path);
  }
}

/** Raised for unexpected invariant violations; maps to INTERNAL_UNAVAILABLE. */
export class Invariant extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Invariant";
  }
}

export function fail(code: ErrorCode, path = ""): never {
  throw new Fail(code, path);
}

export function invariant(condition: unknown, message = "internal invariant"): asserts condition {
  if (!condition) throw new Invariant(String(message));
}
