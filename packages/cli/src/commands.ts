import {
  base64urlEncode,
  canonicalize,
  concatBytes,
  ed25519PublicFromSeed,
  encodeSeed,
  err,
  hashHex,
  isPlainObject,
  isValidTime,
  J,
  nanoidEntryIds,
  newKeyId,
  nowUtcTime,
  parseJsonBytes,
  randomSeed,
  renderText,
  runCheck,
  runSealRetrieval,
  seedSigner,
  timeAfterSeconds,
  U,
  vBatchResult,
  vRetrievalBody,
  vVerifyResult,
  verifyPackageInternal,
  type BatchResult,
  type CheckContext,
  type JsonError,
  type Package,
  type RetrievalBody,
  type TrustContext,
  type VerifyResult,
} from "@latticeag/polycite-core";
import { flagOn, flagValue, parseArgs, UsageError, type ParsedArgs } from "./args.js";
import { loadConfig, localSignerFromConfig, resolveRetrievalKey } from "./config.js";
import { CliError, readInputBytes, writeExclusive } from "./fsio.js";
import { batchExit, exitForError, outcomeExit } from "./exits.js";

const VERSION = "1.0.0";
const MAX_INPUT = 1 << 20; // request admission bound
const MAX_PACKAGE = 16 << 20;

export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  jsonMode: boolean;
  quiet: boolean;
  cwd: string;
}

function emit(io: Io, e: JsonError): void {
  io.stderr(io.jsonMode ? canonicalize(e) : `polycite: ${e.error.code} at ${e.error.path}`);
}

function emitMsg(io: Io, message: string): void {
  io.stderr(io.jsonMode ? canonicalize({ error: message }) : `polycite: ${message}`);
}

function isJsonErr(v: unknown): v is JsonError {
  return (
    isPlainObject(v) &&
    (v as { version?: unknown }).version === "pc-error-1" &&
    isPlainObject((v as { error?: unknown }).error) &&
    typeof (v as { error: { code?: unknown } }).error.code === "string"
  );
}

function outBytes(io: Io, args: ParsedArgs, bytes: Uint8Array): void {
  const out = flagValue(args.flags, "out");
  if (out !== undefined) writeExclusive(out, bytes, 0o600, io.cwd);
  else io.stdout(new TextDecoder().decode(bytes));
}

function trustFromConfig(
  config: { tenant_id: string; contract: unknown; receipt_keys: TrustContext["receipt_keys"] },
  contractHash: string,
  now: string,
  purpose: TrustContext["purpose"],
): TrustContext {
  return {
    tenant_id: config.tenant_id,
    contract_hash: contractHash,
    receipt_keys: config.receipt_keys,
    now,
    purpose,
  };
}

async function ctxFromConfig(io: Io, configPath: string): Promise<CheckContext> {
  const loaded = await loadConfig(configPath, io.cwd);
  const signer = await localSignerFromConfig(loaded);
  return {
    tenant_id: loaded.config.tenant_id,
    contract: loaded.config.contract,
    as_of: nowUtcTime(),
    signer,
    receipt_keys: loaded.config.receipt_keys,
    next_entry_id: nanoidEntryIds(),
    signal: { aborted: false },
  };
}

/** `polycite keygen --out KEYFILE --public-out PUBFILE` */
async function cmdKeygen(io: Io, args: ParsedArgs): Promise<number> {
  const out = flagValue(args.flags, "out");
  const pubOut = flagValue(args.flags, "public-out");
  if (out === undefined || pubOut === undefined)
    throw new UsageError("keygen requires --out and --public-out");
  const seed = randomSeed();
  const pub = await ed25519PublicFromSeed(seed);
  const now = nowUtcTime();
  const notAfter = timeAfterSeconds(now, 365 * 86400);
  if (notAfter === null) throw new CliError("system clock out of keygen range", 24);
  const record = {
    key_id: newKeyId(),
    public_key: base64urlEncode(pub),
    not_before: now,
    not_after: notAfter,
    revoked: false,
  };
  writeExclusive(out, U(encodeSeed(seed)), 0o600, io.cwd);
  writeExclusive(pubOut, concatBytes(J(record), U("\n")), 0o644, io.cwd);
  io.stdout('{"created":true}\n');
  return 0;
}

/** `polycite seal --input BODY.json --key KEYFILE --out SEALED.json` */
async function cmdSeal(io: Io, args: ParsedArgs): Promise<number> {
  const input = flagValue(args.flags, "input");
  const key = flagValue(args.flags, "key");
  const out = flagValue(args.flags, "out");
  if (input === undefined || key === undefined || out === undefined)
    throw new UsageError("seal requires --input, --key and --out");
  const loaded = await loadConfig(String(flagValue(args.flags, "config") ?? "polycite.json"), io.cwd);
  const { key_id, seed } = await resolveRetrievalKey(loaded, key, io.cwd);
  const bytes = readInputBytes(input, io.cwd);
  if (bytes.length > MAX_INPUT) throw new CliError("input exceeds admission bound", 20);
  let body: unknown;
  try {
    body = parseJsonBytes(bytes);
  } catch {
    emit(io, err("BAD_JSON", ""));
    return 20;
  }
  try {
    vRetrievalBody(body, "");
  } catch (e) {
    emit(io, (e as { json: JsonError }).json);
    return exitForError((e as { json: JsonError }).json);
  }
  const r = await runSealRetrieval(body as unknown as RetrievalBody, seedSigner(key_id, seed));
  if (isJsonErr(r)) {
    emit(io, r);
    return exitForError(r);
  }
  writeExclusive(out, concatBytes(J(r), U("\n")), 0o600, io.cwd);
  if (!io.quiet) io.stdout('{"created":true}\n');
  return 0;
}

async function postHosted(
  io: Io,
  args: ParsedArgs,
  pathPart: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<{ status: number; body: Uint8Array }> {
  const loaded = await loadConfig(String(flagValue(args.flags, "config") ?? "polycite.json"), io.cwd);
  const hosted = loaded.config.hosted;
  if (hosted === null) throw new CliError("no hosted endpoint configured", 23);
  const token = process.env[hosted.token_env];
  if (token === undefined || token.length === 0)
    throw new CliError(`hosted bearer token missing in ${hosted.token_env}`, 23);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(hosted.base_url + pathPart, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      signal: ctrl.signal,
    });
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  } catch {
    return { status: -1, body: new Uint8Array() };
  } finally {
    clearTimeout(t);
  }
}

function hostedResponseToError(io: Io, res: { status: number; body: Uint8Array }): number {
  if (res.status === -1) {
    emitMsg(io, "hosted request failed");
    return 22;
  }
  try {
    const v = parseJsonBytes(res.body);
    if (isJsonErr(v)) {
      emit(io, v);
      return exitForError(v);
    }
  } catch {
    /* fall through */
  }
  emitMsg(io, `hosted endpoint returned HTTP ${res.status}`);
  return 22;
}

/** `polycite check --input REQUEST.json [--hosted] [--out PACKAGE.json]` */
async function cmdCheck(io: Io, args: ParsedArgs): Promise<number> {
  const input = flagValue(args.flags, "input");
  if (input === undefined) throw new UsageError("check requires --input");
  const bytes = readInputBytes(input, io.cwd);
  if (bytes.length > MAX_INPUT) throw new CliError("input exceeds admission bound", 20);

  if (flagOn(args.flags, "hosted")) {
    const res = await postHosted(io, args, "/v1/verify", bytes);
    if (res.status !== 200) return hostedResponseToError(io, res);
    return finishHostedCheck(io, args, bytes, res.body);
  }

  let request: unknown;
  try {
    request = parseJsonBytes(bytes);
  } catch {
    emit(io, err("BAD_JSON", ""));
    return 20;
  }
  const ctx = await ctxFromConfig(io, String(flagValue(args.flags, "config") ?? "polycite.json"));
  const r = await runCheck(request, ctx);
  if (isJsonErr(r)) {
    emit(io, r);
    return exitForError(r);
  }
  const pkg: Package = { version: "pc-package-1", request: request as Package["request"], result: r };
  outBytes(io, args, concatBytes(J(pkg), U("\n")));
  return outcomeExit(r.decision.outcome);
}

async function finishHostedCheck(
  io: Io,
  args: ParsedArgs,
  reqBytes: Uint8Array,
  resBytes: Uint8Array,
): Promise<number> {
  const loaded = await loadConfig(String(flagValue(args.flags, "config") ?? "polycite.json"), io.cwd);
  const contractHash = await hashHex(J(loaded.config.contract));
  let request: unknown;
  let result: unknown;
  try {
    request = parseJsonBytes(reqBytes);
    result = parseJsonBytes(resBytes);
    vVerifyResult(result, "");
  } catch (e) {
    const je = (e as { json?: JsonError }).json;
    emit(io, je ?? err("PACKAGE_INVALID", ""));
    return 21;
  }
  const pkg: Package = {
    version: "pc-package-1",
    request: request as Package["request"],
    result: result as VerifyResult,
  };
  const v = await verifyPackageInternal(
    pkg,
    trustFromConfig(loaded.config, contractHash, nowUtcTime(), "delivery"),
  );
  if (!v.valid) {
    emit(io, v.failure);
    return exitForError(v.failure);
  }
  outBytes(io, args, concatBytes(J(pkg), U("\n")));
  return outcomeExit(v.outcome);
}

/** `polycite batch --input BATCH.json --hosted [--out RESULT.json]` */
async function cmdBatch(io: Io, args: ParsedArgs): Promise<number> {
  const input = flagValue(args.flags, "input");
  if (input === undefined) throw new UsageError("batch requires --input");
  const bytes = readInputBytes(input, io.cwd);
  if (bytes.length > MAX_INPUT) throw new CliError("input exceeds admission bound", 20);
  if (!flagOn(args.flags, "hosted")) {
    emitMsg(io, "batch verification requires --hosted (the batch route is worker-only)");
    return 23;
  }
  const res = await postHosted(io, args, "/v1/batches/verify", bytes);
  if (res.status !== 200) return hostedResponseToError(io, res);
  let result: unknown;
  try {
    result = parseJsonBytes(res.body);
    vBatchResult(result, "");
  } catch {
    emitMsg(io, "hosted endpoint returned an invalid batch result");
    return 21;
  }
  const br = result as BatchResult;
  outBytes(io, args, concatBytes(J(br), U("\n")));
  const exits = br.items.map((item) =>
    item.ok ? outcomeExit(item.result.decision.outcome) : exitForError(item.failure),
  );
  return batchExit(exits);
}

/** `polycite inspect --input PACKAGE.json [--at TIME]` */
async function cmdInspect(io: Io, args: ParsedArgs): Promise<number> {
  const input = flagValue(args.flags, "input");
  if (input === undefined) throw new UsageError("inspect requires --input");
  const bytes = readInputBytes(input, io.cwd);
  if (bytes.length > MAX_PACKAGE) throw new CliError("package exceeds admission bound", 20);
  let pkg: unknown;
  try {
    pkg = parseJsonBytes(bytes);
  } catch {
    emit(io, err("BAD_JSON", ""));
    return 20;
  }
  const loaded = await loadConfig(String(flagValue(args.flags, "config") ?? "polycite.json"), io.cwd);
  const at = flagValue(args.flags, "at") ?? nowUtcTime();
  if (!isValidTime(at)) throw new CliError("--at is not a valid time", 23);
  const contractHash = await hashHex(J(loaded.config.contract));
  const v = await verifyPackageInternal(
    pkg,
    trustFromConfig(loaded.config, contractHash, at, "historical"),
  );
  io.stdout(Buffer.from(J(v)).toString("utf8") + "\n");
  if (!v.valid) return exitForError(v.failure);
  return 0;
}

/** `polycite render --input PACKAGE.json [--out TEXT]` */
async function cmdRender(io: Io, args: ParsedArgs): Promise<number> {
  const input = flagValue(args.flags, "input");
  if (input === undefined) throw new UsageError("render requires --input");
  const bytes = readInputBytes(input, io.cwd);
  if (bytes.length > MAX_PACKAGE) throw new CliError("package exceeds admission bound", 20);
  let pkg: unknown;
  try {
    pkg = parseJsonBytes(bytes);
  } catch {
    emit(io, err("BAD_JSON", ""));
    return 20;
  }
  const loaded = await loadConfig(String(flagValue(args.flags, "config") ?? "polycite.json"), io.cwd);
  const contractHash = await hashHex(J(loaded.config.contract));
  const v = await verifyPackageInternal(
    pkg,
    trustFromConfig(loaded.config, contractHash, nowUtcTime(), "delivery"),
  );
  if (!v.valid) {
    emit(io, v.failure);
    return exitForError(v.failure);
  }
  const p = pkg as Package;
  const text = renderText(p.result.decision, p.result.final_text);
  if (text === null) {
    if (!io.quiet) emitMsg(io, "verification blocked release; no text emitted");
    return 11;
  }
  const out = flagValue(args.flags, "out");
  if (out !== undefined) writeExclusive(out, U(text), 0o600, io.cwd);
  else io.stdout(text + "\n");
  return outcomeExit(v.outcome);
}

/** `polycite config check` */
async function cmdConfigCheck(io: Io, args: ParsedArgs): Promise<number> {
  const p = String(flagValue(args.flags, "config") ?? "polycite.json");
  try {
    await loadConfig(p, io.cwd);
  } catch (e) {
    emitMsg(io, (e as Error).message);
    return 23;
  }
  io.stdout('{"valid":true}\n');
  return 0;
}

const USAGE = `polycite ${VERSION}

Usage:
  polycite keygen --out KEYFILE --public-out PUBFILE
  polycite seal --input BODY.json --key KEYFILE --out SEALED.json [--config FILE]
  polycite check --input REQUEST.json [--hosted] [--out PACKAGE.json] [--config FILE]
  polycite batch --input BATCH.json --hosted [--out RESULT.json] [--config FILE]
  polycite inspect --input PACKAGE.json [--at TIME] [--config FILE]
  polycite render --input PACKAGE.json [--out TEXT] [--config FILE]
  polycite config check [--config FILE]

Global flags: --config FILE (default ./polycite.json) --json --quiet --help --version
Exit codes: 0 release/valid, 10 annotated, 11 blocked/withheld,
  20 admission, 21 binding/digest/chain, 22 availability, 23 config/usage, 24 internal
`;

const SPEC: Record<string, Set<string>> = {
  keygen: new Set(["out", "public-out"]),
  seal: new Set(["input", "key", "out"]),
  check: new Set(["input", "out", "hosted"]),
  batch: new Set(["input", "out", "hosted"]),
  inspect: new Set(["input", "at"]),
  render: new Set(["input", "out"]),
  "config check": new Set(),
  config: new Set(),
  "": new Set(),
};

export async function dispatch(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv, SPEC);
  if (flagOn(args.flags, "help") || args.command.length === 0) {
    io.stdout(USAGE);
    return 0;
  }
  if (flagOn(args.flags, "version")) {
    io.stdout(VERSION + "\n");
    return 0;
  }
  const cmd = args.command.join(" ");
  switch (cmd) {
    case "keygen":
      return cmdKeygen(io, args);
    case "seal":
      return cmdSeal(io, args);
    case "check":
      return cmdCheck(io, args);
    case "batch":
      return cmdBatch(io, args);
    case "inspect":
      return cmdInspect(io, args);
    case "render":
      return cmdRender(io, args);
    case "config check":
      return cmdConfigCheck(io, args);
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }
}
