import { fail } from "./errors.js";
import { isCanonicalBase64url, utf8Length } from "./bytes.js";
import { isPlainObject } from "./jcs.js";
import { isBatchId, isEntryId, isKeyId, isRunId, isSourceId, isTenantId } from "./ids.js";
import { isValidTime } from "./time.js";
import { isDisallowedControl } from "./text.js";
import type { ErrorCode } from "./types.js";

/**
 * Closed-schema validators. Each validator throws Fail on the first offending
 * field; object fields are visited in schema declaration order and unknown
 * members are reported afterward in ascending canonical (RFC 8785) key order.
 */

export type V = (v: unknown, p: string) => void;

const esc = (seg: string): string => seg.replace(/~/g, "~0").replace(/\//g, "~1");
export const join = (p: string, seg: string): string => p + "/" + esc(seg);
const ipath = (p: string, i: number): string => p + "/" + i;

/* ---------- primitives ---------- */

export const vString: V = (v, p) => {
  if (typeof v !== "string") fail("SCHEMA_INVALID", p);
};

export const vWellFormed: V = (v, p) => {
  if (typeof v !== "string" || !v.isWellFormed()) fail("SCHEMA_INVALID", p);
};

export const vBool: V = (v, p) => {
  if (typeof v !== "boolean") fail("SCHEMA_INVALID", p);
};

export const vNull: V = (v, p) => {
  if (v !== null) fail("SCHEMA_INVALID", p);
};

export const vUInt: V = (v, p) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 9007199254740991 || Object.is(v, -0))
    fail("SCHEMA_INVALID", p);
};

export function vEnum<T extends string | number | boolean>(...values: T[]): V {
  return (v, p) => {
    if (!values.includes(v as T)) fail("SCHEMA_INVALID", p);
  };
}

/** Version discriminator: present non-string or missing -> SCHEMA_INVALID;
 *  present string with wrong value -> UNSUPPORTED_VERSION. */
export function vVersion(expected: string): V {
  return (v, p) => {
    if (typeof v !== "string") fail("SCHEMA_INVALID", p);
    if (v !== expected) fail("UNSUPPORTED_VERSION", p);
  };
}

export const vHash: V = (v, p) => {
  if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) fail("SCHEMA_INVALID", p);
};

export const vTime: V = (v, p) => {
  if (!isValidTime(v)) fail("SCHEMA_INVALID", p);
};

export const vSignature: V = (v, p) => {
  if (typeof v !== "string" || !isCanonicalBase64url(v, 64)) fail("SCHEMA_INVALID", p);
};

export const vPublicKey: V = (v, p) => {
  if (typeof v !== "string" || !isCanonicalBase64url(v, 32)) fail("SCHEMA_INVALID", p);
};

export const vAuthority: V = (v, p) => {
  if (typeof v !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(v)) fail("SCHEMA_INVALID", p);
};

const ORIGIN_FORBIDDEN = (cp: number): boolean =>
  cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f) || isDisallowedControl(cp);

export const vOrigin: V = (v, p) => {
  if (typeof v !== "string" || !v.isWellFormed()) fail("SCHEMA_INVALID", p);
  const n = utf8Length(v);
  if (n < 1) fail("SCHEMA_INVALID", p);
  if (n > 512) fail("TOO_LARGE", p);
  for (const ch of v) {
    const cp = ch.codePointAt(0)!;
    if (ORIGIN_FORBIDDEN(cp)) fail("SCHEMA_INVALID", p);
  }
};

export function vId(check: (v: unknown) => boolean): V {
  return (v, p) => {
    if (!check(v)) fail("SCHEMA_INVALID", p);
  };
}

/** Text field with a UTF-8 byte ceiling; over-max is TOO_LARGE at the field. */
export function vText(maxBytes: number, minBytes = 0): V {
  return (v, p) => {
    if (typeof v !== "string") fail("SCHEMA_INVALID", p);
    const n = utf8Length(v);
    if (n > maxBytes) fail("TOO_LARGE", p);
    if (n < minBytes) fail("SCHEMA_INVALID", p);
  };
}

export function vSpan(v: unknown, p: string): void {
  obj(v, p, [
    ["start", vUInt],
    ["end", vUInt],
  ]);
  const s = v as { start: number; end: number };
  if (!(s.start < s.end)) fail("SCHEMA_INVALID", join(p, "end"));
}

/* ---------- combinators ---------- */

/**
 * Closed object: declared fields in order, then unknown members in ascending
 * canonical key order. Inherited members and non-plain objects are rejected.
 */
export function obj(v: unknown, p: string, fields: readonly (readonly [string, V])[]): asserts v is Record<string, unknown> {
  if (!isPlainObject(v)) fail("SCHEMA_INVALID", p);
  const declared = new Set<string>();
  for (const [name, check] of fields) {
    declared.add(name);
    if (!Object.prototype.hasOwnProperty.call(v, name)) fail("SCHEMA_INVALID", join(p, name));
    check((v as Record<string, unknown>)[name], join(p, name));
  }
  const unknown = Object.keys(v as Record<string, unknown>)
    .filter((k) => !declared.has(k))
    .sort();
  if (unknown.length > 0) fail("SCHEMA_INVALID", join(p, unknown[0]!));
}

export function arr(item: V, min: number, max: number): V {
  return (v, p) => {
    if (!Array.isArray(v)) fail("SCHEMA_INVALID", p);
    if (v.length < min || v.length > max) fail("SCHEMA_INVALID", p);
    for (let i = 0; i < v.length; i++) item(v[i], ipath(p, i));
  };
}

export function opt(inner: V): V {
  return (v, p) => {
    if (v === null) return;
    inner(v, p);
  };
}

/* ---------- trust and contract ---------- */

export function vKeyRecord(v: unknown, p: string): void {
  obj(v, p, [
    ["key_id", vId(isKeyId)],
    ["public_key", vPublicKey],
    ["not_before", vTime],
    ["not_after", vTime],
    ["revoked", vBool],
  ]);
}

export function vRetrievalKey(v: unknown, p: string): void {
  obj(v, p, [
    ["key_id", vId(isKeyId)],
    ["public_key", vPublicKey],
    ["not_before", vTime],
    ["not_after", vTime],
    ["revoked", vBool],
    [
      "authorities",
      (val, pp) => {
        arr(vAuthority, 1, 16)(val, pp);
        const a = val as string[];
        for (let i = 1; i < a.length; i++) {
          if (!(a[i - 1]! < a[i]!)) fail("SCHEMA_INVALID", ipath(pp, i));
        }
      },
    ],
  ]);
}

export function vContract(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-contract-1")],
    ["delivery", vEnum("block", "annotate")],
    ["rewrite", vEnum("off", "prune")],
    [
      "max_age_s",
      (val, pp) => {
        vUInt(val, pp);
        if ((val as number) < 1 || (val as number) > 86400) fail("SCHEMA_INVALID", pp);
      },
    ],
    [
      "future_skew_s",
      (val, pp) => {
        vUInt(val, pp);
        if ((val as number) > 120) fail("SCHEMA_INVALID", pp);
      },
    ],
    ["splitter", vEnum("pc-split-1")],
    ["grammar", vEnum("pc-en-1")],
    [
      "retrieval_keys",
      (val, pp) => {
        arr(vRetrievalKey, 1, 16)(val, pp);
        const ks = val as { key_id: string }[];
        for (let i = 1; i < ks.length; i++) {
          if (!(ks[i - 1]!.key_id < ks[i]!.key_id)) fail("SCHEMA_INVALID", ipath(pp, i));
        }
      },
    ],
  ]);
}

/* ---------- retrieval and request ---------- */

export function vSource(v: unknown, p: string): void {
  obj(v, p, [
    ["source_id", vId(isSourceId)],
    ["kind", vEnum("text", "table", "chart")],
    ["authority", vAuthority],
    ["role", vEnum("primary", "secondary")],
    ["origin", vOrigin],
    ["extraction", vEnum("standalone", "contextual")],
    ["text", vText(65536, 1)],
    ["content_hash", vHash],
  ]);
}

export function vRetrievalBody(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-retrieval-1")],
    ["audience", vId(isTenantId)],
    ["retrieved_at", vTime],
    ["sources", arr(vSource, 1, 16)],
  ]);
}

export function vRetrieval(v: unknown, p: string): void {
  obj(v, p, [
    ["body", vRetrievalBody],
    ["hash", vHash],
    ["key_id", vId(isKeyId)],
    ["signature", vSignature],
  ]);
}

export function vVerifyRequest(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-request-1")],
    ["run_id", vId(isRunId)],
    ["contract_hash", vHash],
    ["format", vEnum("plain", "markdown", "table", "chart")],
    ["language", vEnum("en")],
    ["draft", vText(32768)],
    ["retrieval", vRetrieval],
  ]);
}

export function vBatchRequest(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-batch-request-1")],
    ["batch_id", vId(isBatchId)],
    ["items", arr(vVerifyRequest, 1, 8)],
  ]);
}

/* ---------- decision and audit ---------- */

export function vLink(v: unknown, p: string): void {
  obj(v, p, [
    ["relation", vEnum("supports", "contradicts")],
    ["source_id", vId(isSourceId)],
    ["span", vSpan],
    ["content_hash", vHash],
    ["retrieval_hash", vHash],
  ]);
}

export function vAtomResult(v: unknown, p: string): void {
  obj(v, p, [
    ["index", vUInt],
    ["span", vSpan],
    ["verdict", vEnum("supported", "unsupported", "contradicted")],
    ["reason", vEnum("MATCH", "CONFLICT", "NO_EVIDENCE", "PRIMARY_REQUIRED", "CONTEXT", "SYNTAX")],
    ["links", arr(vLink, 0, 8)],
    [
      "totals",
      (val, pp) =>
        obj(val, pp, [
          ["supports", vUInt],
          ["contradicts", vUInt],
        ]),
    ],
  ]);
}

export function vClaimResult(v: unknown, p: string): void {
  obj(v, p, [
    ["index", vUInt],
    ["span", vSpan],
    ["verdict", vEnum("supported", "unsupported", "contradicted")],
    ["reason", vEnum("ALL_SUPPORTED", "ATOM_UNSUPPORTED", "ATOM_CONTRADICTED")],
    ["atoms", arr(vAtomResult, 1, 8)],
  ]);
}

export function vRewrite(v: unknown, p: string): void {
  obj(v, p, [
    ["claim_index", vUInt],
    ["original_span", vSpan],
    [
      "removed_atoms",
      (val, pp) => {
        arr(vUInt, 1, 8)(val, pp);
        const a = val as number[];
        for (let i = 1; i < a.length; i++) {
          if (!(a[i - 1]! < a[i]!)) fail("SCHEMA_INVALID", ipath(pp, i));
        }
      },
    ],
    ["before_hash", vHash],
    ["after_hash", vHash],
    ["replacement", vString],
  ]);
}

export function vDecision(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-decision-1")],
    ["contract_hash", vHash],
    ["retrieval_hash", vHash],
    ["as_of", vTime],
    ["original_hash", vHash],
    ["final_hash", vHash],
    ["initial", arr(vClaimResult, 1, 128)],
    ["final", arr(vClaimResult, 1, 128)],
    ["rewrites", arr(vRewrite, 0, 128)],
    ["outcome", vEnum("release", "annotated", "blocked")],
  ]);
}

export function vEventPayload(v: unknown, p: string): void {
  if (!isPlainObject(v)) fail("SCHEMA_INVALID", p);
  const kind = (v as Record<string, unknown>)["kind"];
  if (typeof kind !== "string") fail("SCHEMA_INVALID", join(p, "kind"));
  switch (kind) {
    case "accepted":
      obj(v, p, [
        ["kind", vEnum("accepted")],
        ["request_hash", vHash],
        ["contract_hash", vHash],
        ["retrieval_hash", vHash],
      ]);
      return;
    case "evaluated":
      obj(v, p, [
        ["kind", vEnum("evaluated")],
        ["revision", vEnum(0, 1)],
        ["claims_hash", vHash],
        ["draft_hash", vHash],
      ]);
      return;
    case "rewritten":
      obj(v, p, [
        ["kind", vEnum("rewritten")],
        ["rewrites_hash", vHash],
        ["final_hash", vHash],
      ]);
      return;
    case "delivery_prepared":
      obj(v, p, [
        ["kind", vEnum("delivery_prepared")],
        ["decision_hash", vHash],
        ["delivery_hash", (val, pp) => opt(vHash)(val, pp)],
        ["outcome", vEnum("release", "annotated", "blocked")],
      ]);
      return;
    default:
      fail("SCHEMA_INVALID", join(p, "kind"));
  }
}

export function vEntryBody(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-entry-1")],
    ["entry_id", vId(isEntryId)],
    ["tenant_id", vId(isTenantId)],
    ["run_id", vId(isRunId)],
    ["sequence", vUInt],
    ["at", vTime],
    ["previous_hash", (val, pp) => opt(vHash)(val, pp)],
    ["payload", vEventPayload],
  ]);
}

export function vEntry(v: unknown, p: string): void {
  obj(v, p, [
    ["body", vEntryBody],
    ["hash", vHash],
    ["key_id", vId(isKeyId)],
    ["signature", vSignature],
  ]);
}

export function vVerifyResult(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-result-1")],
    ["run_id", vId(isRunId)],
    ["tenant_id", vId(isTenantId)],
    ["request_hash", vHash],
    ["contract", vContract],
    ["decision", vDecision],
    ["final_text", vString],
    ["audit", arr(vEntry, 1, 5)],
    ["head_hash", vHash],
  ]);
}

export function vPackage(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-package-1")],
    ["request", vVerifyRequest],
    ["result", vVerifyResult],
  ]);
}

const ERROR_CODES: readonly ErrorCode[] = [
  "BAD_JSON",
  "SCHEMA_INVALID",
  "UNSUPPORTED_VERSION",
  "UNSUPPORTED_MEDIA_TYPE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "TOO_LARGE",
  "CONTRACT_MISMATCH",
  "AUDIENCE_MISMATCH",
  "EMPTY_DRAFT",
  "DISALLOWED_CONTROL",
  "NON_TEXT_INPUT",
  "BAD_CONTENT_HASH",
  "BAD_RETRIEVAL_HASH",
  "BAD_RETRIEVAL_SIGNATURE",
  "UNTRUSTED_RETRIEVER",
  "STALE_RETRIEVAL",
  "FUTURE_RETRIEVAL",
  "LIMIT_EXCEEDED",
  "RATE_LIMITED",
  "DEADLINE_EXCEEDED",
  "INTERNAL_UNAVAILABLE",
  "PACKAGE_INVALID",
  "UNKNOWN_RECEIPT_KEY",
  "BAD_RECEIPT_SIGNATURE",
  "CHAIN_INVALID",
  "EXPIRED_RECEIPT",
  "RELEASE_MISMATCH",
];

export function vJsonError(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-error-1")],
    [
      "error",
      (val, pp) =>
        obj(val, pp, [
          ["code", vEnum(...ERROR_CODES)],
          ["path", vString],
          ["retryable", vBool],
        ]),
    ],
  ]);
}

export function vBatchItem(v: unknown, p: string): void {
  if (!isPlainObject(v)) fail("SCHEMA_INVALID", p);
  const ok = (v as Record<string, unknown>)["ok"];
  if (ok === true) {
    obj(v, p, [
      ["run_id", vId(isRunId)],
      ["ok", vEnum(true)],
      ["result", vVerifyResult],
    ]);
    return;
  }
  if (ok === false) {
    obj(v, p, [
      ["run_id", vId(isRunId)],
      ["ok", vEnum(false)],
      ["failure", vJsonError],
    ]);
    return;
  }
  fail("SCHEMA_INVALID", join(p, "ok"));
}

export function vBatchResult(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-batch-result-1")],
    ["batch_id", vId(isBatchId)],
    ["items", arr(vBatchItem, 1, 8)],
  ]);
}

export function vKeysResponse(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-keys-1")],
    ["keys", arr(vKeyRecord, 0, 16)],
  ]);
}

export function vHealthResponse(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-health-1")],
    ["status", vEnum("ok", "unavailable")],
    ["protocol", vEnum("pc-request-1")],
  ]);
}

/* ---------- configuration ---------- */

export function vConfig(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-config-1")],
    ["tenant_id", vId(isTenantId)],
    ["contract", vContract],
    [
      "receipt_keys",
      (val, pp) => {
        arr(vKeyRecord, 1, 16)(val, pp);
        const ks = val as { key_id: string }[];
        for (let i = 1; i < ks.length; i++) {
          if (!(ks[i - 1]!.key_id < ks[i]!.key_id)) fail("SCHEMA_INVALID", ipath(pp, i));
        }
      },
    ],
    [
      "local_signer",
      (val, pp) => {
        if (val === null) return;
        obj(val, pp, [
          ["key_id", vId(isKeyId)],
          ["seed_file", (s, sp) => {
            vWellFormed(s, sp);
            if (utf8Length(s as string) < 1 || utf8Length(s as string) > 1024) fail("SCHEMA_INVALID", sp);
          }],
        ]);
      },
    ],
    [
      "hosted",
      (val, pp) => {
        if (val === null) return;
        obj(val, pp, [
          ["base_url", (s, sp) => {
            vWellFormed(s, sp);
            const u = s as string;
            let parsed: URL;
            try {
              parsed = new URL(u);
            } catch {
              fail("SCHEMA_INVALID", sp);
            }
            parsed = parsed!;
            const loopback =
              parsed.hostname === "localhost" ||
              parsed.hostname === "127.0.0.1" ||
              parsed.hostname === "[::1]";
            if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))
              fail("SCHEMA_INVALID", sp);
            if (parsed.username || parsed.password || parsed.search || parsed.hash) fail("SCHEMA_INVALID", sp);
            if (parsed.pathname !== "/" && parsed.pathname !== "") fail("SCHEMA_INVALID", sp);
          }],
          ["token_env", (s, sp) => {
            if (typeof s !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(s)) fail("SCHEMA_INVALID", sp);
          }],
        ]);
      },
    ],
  ]);
}

export function vWorkerConfig(v: unknown, p: string): void {
  obj(v, p, [
    ["version", vVersion("pc-worker-config-1")],
    ["contract", vContract],
    ["receipt_keys", arr(vKeyRecord, 1, 16)],
    [
      "log_sample_ppm",
      (val, pp) => {
        vUInt(val, pp);
        if ((val as number) > 1000000) fail("SCHEMA_INVALID", pp);
      },
    ],
  ]);
}

export function vAuthBinding(v: unknown, p: string): void {
  obj(v, p, [
    ["token_sha256", vHash],
    ["tenant_id", vId(isTenantId)],
    [
      "scopes",
      (val, pp) => {
        arr(vEnum("verify", "keys:read"), 1, 2)(val, pp);
        const a = val as string[];
        for (let i = 1; i < a.length; i++) {
          if (!(a[i - 1]! < a[i]!)) fail("SCHEMA_INVALID", ipath(pp, i));
        }
      },
    ],
  ]);
}
