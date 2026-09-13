import {
  base64urlDecode,
  base64urlEncode,
  bytesEqual,
  decodeSeed,
  err,
  hexDecode,
  isPlainObject,
  J,
  newEntryId,
  parseJsonBytes,
  runCheck,
  seedSigner,
  tokenDigest,
  vAuthBinding,
  vBatchRequest,
  vWorkerConfig,
  type AuthBinding,
  type BatchItem,
  type CheckContext,
  type EntryId,
  type ErrorCode,
  type JsonError,
  type KeyRecord,
  type Signer,
  type Time,
  type VerifyRequest,
  type VerifyResult,
  type WorkerConfig,
} from "@latticeag/polycite-core";
import { Metrics, operationEvent } from "./metrics.js";
import { RateLimiter } from "./limiter.js";

/* ---------- environment ---------- */

export interface WorkerEnv {
  PC_PUBLIC_CONFIG: string;
  PC_SIGNING_SEED: string;
  PC_SIGNING_KEY_ID: string;
  PC_AUTH_BINDINGS: string;
}

/** Test-harness seams (trusted, in-process; never reachable from wire input). */
export interface WorkerHarness {
  /** Fixed wall clock for as_of / now / key publication. */
  wallClock?: () => Time;
  /** Per-item monotonic deadline source. */
  itemMonotonic?: (itemIndex: number) => () => number;
  /** Batch deadline source. */
  batchMonotonic?: () => number;
  /** Sequential entry-ID source. */
  entryIds?: () => EntryId;
  /** Must be true to accept the public fixture seeds/test bearer. */
  testMode?: boolean;
  /** Optional rate-limit override for tests. */
  rateLimiter?: RateLimiter;
}

interface Initialized {
  ok: boolean;
  config?: WorkerConfig;
  signer?: Signer;
  bindings?: AuthBinding[];
  failure?: JsonError;
}

const ROUTES = {
  verify: { method: "POST", path: "/v1/verify", scope: "verify" as const },
  batch: { method: "POST", path: "/v1/batches/verify", scope: "verify" as const },
  keys: { method: "GET", path: "/v1/keys", scope: "keys:read" as const },
  health: { method: "GET", path: "/healthz", scope: null },
};

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_JSON: 400,
  SCHEMA_INVALID: 400,
  UNSUPPORTED_VERSION: 400,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TOO_LARGE: 413,
  CONTRACT_MISMATCH: 422,
  AUDIENCE_MISMATCH: 422,
  EMPTY_DRAFT: 422,
  DISALLOWED_CONTROL: 422,
  NON_TEXT_INPUT: 422,
  BAD_CONTENT_HASH: 422,
  BAD_RETRIEVAL_HASH: 422,
  BAD_RETRIEVAL_SIGNATURE: 422,
  UNTRUSTED_RETRIEVER: 422,
  STALE_RETRIEVAL: 422,
  FUTURE_RETRIEVAL: 422,
  LIMIT_EXCEEDED: 422,
  RATE_LIMITED: 429,
  DEADLINE_EXCEEDED: 503,
  INTERNAL_UNAVAILABLE: 503,
  PACKAGE_INVALID: 422,
  UNKNOWN_RECEIPT_KEY: 422,
  BAD_RECEIPT_SIGNATURE: 422,
  CHAIN_INVALID: 422,
  EXPIRED_RECEIPT: 422,
  RELEASE_MISMATCH: 422,
};

const VERIFY_BODY_CAP = 393216;
const BATCH_BODY_CAP = 2097152;
const ITEM_DEADLINE_MS = 2000;
const BATCH_DEADLINE_MS = 20000;
const MAX_CONCURRENT = 2;

/** The public all-zero test credential (43 chars of canonical zero bytes). */
const TEST_TOKEN = "A".repeat(43);
/** Public fixture seeds: K(0) -> bytes 0..31, K(32) -> bytes 32..63. */
const TEST_SEEDS: string[] = [
  base64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => i)),
  base64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => 32 + i)),
];

function jsonResponse(status: number, value: unknown, extra?: Record<string, string>): Response {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  if (extra) for (const [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(new Blob([new Uint8Array(J(value))], { type: "application/json" }), {
    status,
    headers,
  });
}

function errorResponse(code: ErrorCode, path = ""): Response {
  const e = err(code, path);
  const extra = code === "RATE_LIMITED" ? { "retry-after": "1" } : undefined;
  return jsonResponse(STATUS_BY_CODE[code], e, extra);
}

function isError(v: VerifyResult | JsonError | unknown): v is JsonError {
  return isPlainObject(v) && (v as { version?: unknown }).version === "pc-error-1";
}

interface Auth {
  tenant_id: string;
  scopes: string[];
  bindingIndex: number;
}

export interface WorkerHandle {
  fetch: (req: Request) => Promise<Response>;
  ready: () => Promise<boolean>;
  metrics: () => ReturnType<Metrics["snapshot"]>;
  opLog: () => readonly unknown[];
}

export function createWorker(env: WorkerEnv, harness: WorkerHarness = {}): WorkerHandle {
  const metrics = new Metrics();
  const limiter = harness.rateLimiter ?? new RateLimiter();
  const opEvents: unknown[] = [];
  const wallClock = harness.wallClock ?? (() => defaultNow());
  const batchClock = harness.batchMonotonic ?? (() => performance.now());
  const entryIds = harness.entryIds ?? (() => newEntryId());

  const init: Initialized = initialize(env, harness);

  function sampleOp(meta: { route: string; status: number; code: ErrorCode | null; duration_ms: number; input_bytes: number }): void {
    const ppm = init.config?.log_sample_ppm ?? 0;
    if (ppm <= 0) return;
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! / 0x100000000 < ppm / 1000000) opEvents.push(operationEvent(meta));
    if (opEvents.length > 1024) opEvents.splice(0, opEvents.length - 1024);
  }

  function recordOutcome(route: string, status: number, code: ErrorCode | null, startMs: number, inputBytes: number): void {
    metrics.inc("pc_requests_total", { route, status });
    if (code) metrics.inc("pc_errors_total", { code });
    const duration = Math.max(0, batchClock() - startMs);
    metrics.observeMs("pc_check_ms", duration);
    metrics.observeBytes("pc_input_bytes", inputBytes);
    sampleOp({ route, status, code, duration_ms: duration, input_bytes: inputBytes });
  }

  async function authenticate(req: Request): Promise<Auth | JsonError> {
    const header = req.headers.get("authorization");
    if (header === null || header.includes(",")) return err("UNAUTHENTICATED");
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
    if (!m) return err("UNAUTHENTICATED");
    const token = m[1]!;
    if (!harness.testMode && token === TEST_TOKEN) return err("UNAUTHENTICATED");
    const raw = base64urlDecode(token);
    if (raw === null || raw.length !== 32 || base64urlEncode(raw) !== token) return err("UNAUTHENTICATED");
    const digest = hexDecode(await tokenDigest(token));
    let found = -1;
    for (let i = 0; i < (init.bindings?.length ?? 0); i++) {
      const b = init.bindings![i]!;
      if (bytesEqual(digest, hexDecode(b.token_sha256))) found = i;
    }
    if (found < 0) return err("UNAUTHENTICATED");
    const b = init.bindings![found]!;
    return { tenant_id: b.tenant_id, scopes: b.scopes, bindingIndex: found };
  }

  function contextFor(auth: Auth, itemIndex: number, signal: AbortSignal): CheckContext {
    return {
      tenant_id: auth.tenant_id,
      contract: init.config!.contract,
      as_of: wallClock(),
      signer: init.signer!,
      receipt_keys: init.config!.receipt_keys,
      next_entry_id: entryIds,
      signal,
      monotonic_ms: harness.itemMonotonic ? harness.itemMonotonic(itemIndex) : undefined,
      deadline_ms: ITEM_DEADLINE_MS,
      timings: { observe: (name, ms) => metrics.observeMs(name, ms) },
    };
  }

  async function readBody(req: Request, cap: number): Promise<Uint8Array | JsonError> {
    const cl = req.headers.get("content-length");
    if (cl !== null && /^\d+$/.test(cl) && Number(cl) > cap) return err("TOO_LARGE");
    let buf: ArrayBuffer;
    try {
      buf = await req.arrayBuffer();
    } catch {
      return err("BAD_JSON");
    }
    if (buf.byteLength > cap) return err("TOO_LARGE");
    return new Uint8Array(buf);
  }

  function mediaOk(req: Request): JsonError | null {
    const ct = req.headers.get("content-type");
    if (ct === null) return err("UNSUPPORTED_MEDIA_TYPE");
    const mime = ct.split(";")[0]!.trim().toLowerCase();
    if (mime !== "application/json") return err("UNSUPPORTED_MEDIA_TYPE");
    const enc = req.headers.get("content-encoding");
    if (enc !== null && enc.trim().toLowerCase() !== "identity") return err("UNSUPPORTED_MEDIA_TYPE");
    return null;
  }

  async function handleVerify(req: Request, auth: Auth, inputBytes: number): Promise<Response> {
    const startMs = batchClock();
    const media = mediaOk(req);
    if (media) {
      recordOutcome("/v1/verify", 415, "UNSUPPORTED_MEDIA_TYPE", startMs, inputBytes);
      return jsonResponse(415, media);
    }
    const body = await readBody(req, VERIFY_BODY_CAP);
    if (isError(body)) {
      recordOutcome("/v1/verify", STATUS_BY_CODE[body.error.code], body.error.code, startMs, inputBytes);
      return jsonResponse(STATUS_BY_CODE[body.error.code], body);
    }
    let value: unknown;
    try {
      value = parseJsonBytes(body);
    } catch (e) {
      const je = (e as { json?: JsonError }).json ?? err("BAD_JSON");
      recordOutcome("/v1/verify", STATUS_BY_CODE[je.error.code], je.error.code, startMs, body.length);
      return jsonResponse(STATUS_BY_CODE[je.error.code], je);
    }
    const out = await runCheck(value, contextFor(auth, 0, req.signal));
    if (isError(out)) {
      if (out.error.code === "INTERNAL_UNAVAILABLE")
        metrics.inc("pc_package_validation_failures_total", {});
      recordOutcome("/v1/verify", STATUS_BY_CODE[out.error.code], out.error.code, startMs, body.length);
      return jsonResponse(STATUS_BY_CODE[out.error.code], out);
    }
    recordItemMetrics(out);
    recordOutcome("/v1/verify", 200, null, startMs, body.length);
    return jsonResponse(200, out);
  }

  function recordItemMetrics(r: VerifyResult): void {
    metrics.inc("pc_items_total", { outcome: r.decision.outcome });
    metrics.observeClaims("pc_claim_count", r.decision.final.length);
    for (const c of r.decision.final)
      for (const a of c.atoms) metrics.inc("pc_atoms_total", { verdict: a.verdict, reason: a.reason });
    if (r.decision.rewrites.length > 0) metrics.inc("pc_rewrite_applied_total", {});
    metrics.inc("pc_rewrite_candidates_total", {}, r.decision.rewrites.length);
    if (r.decision.outcome === "blocked") metrics.inc("pc_blocked_total", {});
  }

  async function handleBatch(req: Request, auth: Auth, inputBytes: number): Promise<Response> {
    const startMs = batchClock();
    const media = mediaOk(req);
    if (media) {
      recordOutcome("/v1/batches/verify", 415, "UNSUPPORTED_MEDIA_TYPE", startMs, inputBytes);
      return jsonResponse(415, media);
    }
    const body = await readBody(req, BATCH_BODY_CAP);
    if (isError(body)) {
      recordOutcome("/v1/batches/verify", STATUS_BY_CODE[body.error.code], body.error.code, startMs, inputBytes);
      return jsonResponse(STATUS_BY_CODE[body.error.code], body);
    }
    let value: unknown;
    try {
      value = parseJsonBytes(body);
    } catch {
      recordOutcome("/v1/batches/verify", 400, "BAD_JSON", startMs, body.length);
      return jsonResponse(400, err("BAD_JSON"));
    }
    try {
      vBatchRequest(value, "");
    } catch (e) {
      const fe = e as { json?: JsonError };
      const j = fe.json ?? err("SCHEMA_INVALID");
      recordOutcome("/v1/batches/verify", STATUS_BY_CODE[j.error.code], j.error.code, startMs, body.length);
      return jsonResponse(STATUS_BY_CODE[j.error.code], j);
    }
    const items = (value as { items: VerifyRequest[] }).items;
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const id = items[i]!.run_id;
      if (seen.has(id)) {
        recordOutcome("/v1/batches/verify", 400, "SCHEMA_INVALID", startMs, body.length);
        return jsonResponse(400, err("SCHEMA_INVALID", `/items/${i}/run_id`));
      }
      seen.add(id);
    }

    const results: (BatchItem | undefined)[] = new Array(items.length);
    const batchStart = batchClock();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        if (batchClock() - batchStart > BATCH_DEADLINE_MS) return;
        const out = await runCheck(items[i]!, contextFor(auth, i, req.signal));
        if (isError(out) && out.error.code === "INTERNAL_UNAVAILABLE")
          metrics.inc("pc_package_validation_failures_total", {});
        results[i] = isError(out)
          ? { run_id: items[i]!.run_id, ok: false, failure: out }
          : { run_id: items[i]!.run_id, ok: true, result: out };
      }
    };
    const lanes = Array.from({ length: Math.min(MAX_CONCURRENT, items.length) }, () => worker());
    await Promise.all(lanes);

    if (batchClock() - batchStart > BATCH_DEADLINE_MS || results.some((r) => r === undefined)) {
      recordOutcome("/v1/batches/verify", 503, "DEADLINE_EXCEEDED", startMs, body.length);
      return jsonResponse(503, err("DEADLINE_EXCEEDED"));
    }
    for (const r of results) if (r!.ok) recordItemMetrics((r as { result: VerifyResult }).result);
    const batch = {
      version: "pc-batch-result-1" as const,
      batch_id: (value as { batch_id: string }).batch_id,
      items: results as BatchItem[],
    };
    recordOutcome("/v1/batches/verify", 200, null, startMs, body.length);
    return jsonResponse(200, batch);
  }

  async function handleKeys(auth: Auth, inputBytes: number): Promise<Response> {
    const startMs = batchClock();
    const nowEpoch = Date.parse(wallClock()) / 1000;
    const keys = (init.config?.receipt_keys ?? [])
      .filter(
        (k) => Date.parse(k.not_before) / 1000 <= nowEpoch && nowEpoch < Date.parse(k.not_after) / 1000,
      )
      .slice()
      .sort((a, b) => (a.key_id < b.key_id ? -1 : a.key_id > b.key_id ? 1 : 0));
    recordOutcome("/v1/keys", 200, null, startMs, inputBytes);
    return jsonResponse(200, { version: "pc-keys-1", keys });
  }

  async function handleHealth(): Promise<Response> {
    const ok = init.ok && (await signerSelfTestOk);
    const status = ok ? "ok" : "unavailable";
    return jsonResponse(ok ? 200 : 503, { version: "pc-health-1", status, protocol: "pc-request-1" });
  }

  const signerSelfTestOk: Promise<boolean> = (async () => {
    if (!init.ok || !init.signer) return false;
    try {
      const probe = new TextEncoder().encode("polycite signer self-test");
      const sig = await init.signer.sign(probe);
      return sig.length === 64;
    } catch {
      return false;
    }
  })();

  async function dispatch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const inputBytes = Number(req.headers.get("content-length") ?? 0) || 0;

    const known = Object.values(ROUTES).find((r) => r.path === path);
    if (!known) {
      if (method === "OPTIONS") {
        recordOutcome("unknown", 405, "METHOD_NOT_ALLOWED", batchClock(), inputBytes);
        return errorResponse("METHOD_NOT_ALLOWED");
      }
      recordOutcome("unknown", 404, "NOT_FOUND", batchClock(), inputBytes);
      return errorResponse("NOT_FOUND");
    }
    if (method !== known.method) {
      recordOutcome(known.path, 405, "METHOD_NOT_ALLOWED", batchClock(), inputBytes);
      return jsonResponse(405, err("METHOD_NOT_ALLOWED"), { allow: known.method });
    }
    if (known === ROUTES.health) {
      const t0 = batchClock();
      const res = await handleHealth();
      recordOutcome("/healthz", res.status, res.status === 200 ? null : "INTERNAL_UNAVAILABLE", t0, 0);
      return res;
    }
    if (!init.ok) {
      recordOutcome(known.path, 503, "INTERNAL_UNAVAILABLE", batchClock(), inputBytes);
      return errorResponse("INTERNAL_UNAVAILABLE");
    }
    const auth = await authenticate(req);
    if (isError(auth)) {
      recordOutcome(known.path, 401, "UNAUTHENTICATED", batchClock(), inputBytes);
      return jsonResponse(401, auth);
    }
    if (known.scope && !auth.scopes.includes(known.scope)) {
      recordOutcome(known.path, 403, "FORBIDDEN", batchClock(), inputBytes);
      return errorResponse("FORBIDDEN");
    }
    if (!limiter.admit(`${auth.bindingIndex}`)) {
      recordOutcome(known.path, 429, "RATE_LIMITED", batchClock(), inputBytes);
      return errorResponse("RATE_LIMITED");
    }
    if (known === ROUTES.verify) return handleVerify(req, auth, inputBytes);
    if (known === ROUTES.batch) return handleBatch(req, auth, inputBytes);
    return handleKeys(auth, inputBytes);
  }

  return {
    fetch: dispatch,
    ready: () => signerSelfTestOk.then((s) => init.ok && s),
    metrics: () => metrics.snapshot(),
    opLog: () => opEvents,
  };

  function defaultNow(): Time {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
  }

  function initialize(env: WorkerEnv, harness: WorkerHarness): Initialized {
    try {
      const cfgValue = parseJsonBytes(new TextEncoder().encode(env.PC_PUBLIC_CONFIG));
      vWorkerConfig(cfgValue, "");
      const config = cfgValue as WorkerConfig;

      const seed = decodeSeed(env.PC_SIGNING_SEED);
      if (!seed) return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };
      if (!harness.testMode && TEST_SEEDS.includes(env.PC_SIGNING_SEED.trim()))
        return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };

      const keyId = env.PC_SIGNING_KEY_ID;
      const record = config.receipt_keys.find((k: KeyRecord) => k.key_id === keyId && !k.revoked);
      if (!record) return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };
      const signer = seedSigner(record.key_id, seed);

      const bindingsValue = parseJsonBytes(new TextEncoder().encode(env.PC_AUTH_BINDINGS));
      if (!Array.isArray(bindingsValue) || bindingsValue.length < 1 || bindingsValue.length > 32)
        return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };
      const seenDigest = new Set<string>();
      for (let i = 0; i < bindingsValue.length; i++) {
        vAuthBinding(bindingsValue[i], `/${i}`);
        const d = (bindingsValue[i] as AuthBinding).token_sha256;
        if (seenDigest.has(d)) return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };
        seenDigest.add(d);
      }
      const bindings = bindingsValue as AuthBinding[];
      return { ok: true, config, signer, bindings };
    } catch {
      return { ok: false, failure: err("INTERNAL_UNAVAILABLE") };
    }
  }
}
