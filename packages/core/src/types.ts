/** Wire primitives and object schemas for the PolyCite pc-*-1 protocols. */

export type Hash = string;
export type Time = string;
export type Signature = string;
export type PublicKey = string;
export type RunId = string;
export type SourceId = string;
export type BatchId = string;
export type EntryId = string;
export type KeyId = string;
export type TenantId = string;
export type UInt = number;

export interface Span {
  start: UInt;
  end: UInt;
}

export type Verdict = "supported" | "unsupported" | "contradicted";
export type Outcome = "release" | "annotated" | "blocked";

export type ErrorCode =
  | "BAD_JSON"
  | "SCHEMA_INVALID"
  | "UNSUPPORTED_VERSION"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "METHOD_NOT_ALLOWED"
  | "TOO_LARGE"
  | "CONTRACT_MISMATCH"
  | "AUDIENCE_MISMATCH"
  | "EMPTY_DRAFT"
  | "DISALLOWED_CONTROL"
  | "NON_TEXT_INPUT"
  | "BAD_CONTENT_HASH"
  | "BAD_RETRIEVAL_HASH"
  | "BAD_RETRIEVAL_SIGNATURE"
  | "UNTRUSTED_RETRIEVER"
  | "STALE_RETRIEVAL"
  | "FUTURE_RETRIEVAL"
  | "LIMIT_EXCEEDED"
  | "RATE_LIMITED"
  | "DEADLINE_EXCEEDED"
  | "INTERNAL_UNAVAILABLE"
  | "PACKAGE_INVALID"
  | "UNKNOWN_RECEIPT_KEY"
  | "BAD_RECEIPT_SIGNATURE"
  | "CHAIN_INVALID"
  | "EXPIRED_RECEIPT"
  | "RELEASE_MISMATCH";

export interface JsonError {
  version: "pc-error-1";
  error: { code: ErrorCode; path: string; retryable: boolean };
}

export interface KeyRecord {
  key_id: KeyId;
  public_key: PublicKey;
  not_before: Time;
  not_after: Time;
  revoked: boolean;
}

export interface RetrievalKey extends KeyRecord {
  authorities: string[];
}

export interface Contract {
  version: "pc-contract-1";
  delivery: "block" | "annotate";
  rewrite: "off" | "prune";
  max_age_s: UInt;
  future_skew_s: UInt;
  splitter: "pc-split-1";
  grammar: "pc-en-1";
  retrieval_keys: RetrievalKey[];
}

export interface Source {
  source_id: SourceId;
  kind: "text" | "table" | "chart";
  authority: string;
  role: "primary" | "secondary";
  origin: string;
  extraction: "standalone" | "contextual";
  text: string;
  content_hash: Hash;
}

export interface RetrievalBody {
  version: "pc-retrieval-1";
  audience: TenantId;
  retrieved_at: Time;
  sources: Source[];
}

export interface Retrieval {
  body: RetrievalBody;
  hash: Hash;
  key_id: KeyId;
  signature: Signature;
}

export interface VerifyRequest {
  version: "pc-request-1";
  run_id: RunId;
  contract_hash: Hash;
  format: "plain" | "markdown" | "table" | "chart";
  language: "en";
  draft: string;
  retrieval: Retrieval;
}

export interface BatchRequest {
  version: "pc-batch-request-1";
  batch_id: BatchId;
  items: VerifyRequest[];
}

export type AtomReason =
  | "MATCH"
  | "CONFLICT"
  | "NO_EVIDENCE"
  | "PRIMARY_REQUIRED"
  | "CONTEXT"
  | "SYNTAX";

export interface Link {
  relation: "supports" | "contradicts";
  source_id: SourceId;
  span: Span;
  content_hash: Hash;
  retrieval_hash: Hash;
}

export interface AtomResult {
  index: UInt;
  span: Span;
  verdict: Verdict;
  reason: AtomReason;
  links: Link[];
  totals: { supports: UInt; contradicts: UInt };
}

export type ClaimReason = "ALL_SUPPORTED" | "ATOM_UNSUPPORTED" | "ATOM_CONTRADICTED";

export interface ClaimResult {
  index: UInt;
  span: Span;
  verdict: Verdict;
  reason: ClaimReason;
  atoms: AtomResult[];
}

export interface Rewrite {
  claim_index: UInt;
  original_span: Span;
  removed_atoms: UInt[];
  before_hash: Hash;
  after_hash: Hash;
  replacement: string;
}

export interface Decision {
  version: "pc-decision-1";
  contract_hash: Hash;
  retrieval_hash: Hash;
  as_of: Time;
  original_hash: Hash;
  final_hash: Hash;
  initial: ClaimResult[];
  final: ClaimResult[];
  rewrites: Rewrite[];
  outcome: Outcome;
}

export type EventPayload =
  | { kind: "accepted"; request_hash: Hash; contract_hash: Hash; retrieval_hash: Hash }
  | { kind: "evaluated"; revision: 0 | 1; claims_hash: Hash; draft_hash: Hash }
  | { kind: "rewritten"; rewrites_hash: Hash; final_hash: Hash }
  | {
      kind: "delivery_prepared";
      decision_hash: Hash;
      delivery_hash: Hash | null;
      outcome: Outcome;
    };

export interface EntryBody {
  version: "pc-entry-1";
  entry_id: EntryId;
  tenant_id: TenantId;
  run_id: RunId;
  sequence: UInt;
  at: Time;
  previous_hash: Hash | null;
  payload: EventPayload;
}

export interface Entry {
  body: EntryBody;
  hash: Hash;
  key_id: KeyId;
  signature: Signature;
}

export interface VerifyResult {
  version: "pc-result-1";
  run_id: RunId;
  tenant_id: TenantId;
  request_hash: Hash;
  contract: Contract;
  decision: Decision;
  final_text: string;
  audit: Entry[];
  head_hash: Hash;
}

export interface Package {
  version: "pc-package-1";
  request: VerifyRequest;
  result: VerifyResult;
}

export type BatchItem =
  | { run_id: RunId; ok: true; result: VerifyResult }
  | { run_id: RunId; ok: false; failure: JsonError };

export interface BatchResult {
  version: "pc-batch-result-1";
  batch_id: BatchId;
  items: BatchItem[];
}

export interface RenderResult {
  outcome: Outcome;
  content_type: "text/plain; charset=utf-8";
  text: string | null;
}

export type ValidationResult =
  | { valid: true; fresh: boolean; head_hash: Hash; decision_hash: Hash; outcome: Outcome }
  | { valid: false; failure: JsonError };

export interface Config {
  version: "pc-config-1";
  tenant_id: TenantId;
  contract: Contract;
  receipt_keys: KeyRecord[];
  local_signer: { key_id: KeyId; seed_file: string } | null;
  hosted: { base_url: string; token_env: string } | null;
}

export interface WorkerConfig {
  version: "pc-worker-config-1";
  contract: Contract;
  receipt_keys: KeyRecord[];
  log_sample_ppm: UInt;
}

export interface AuthBinding {
  token_sha256: Hash;
  tenant_id: TenantId;
  scopes: ("verify" | "keys:read")[];
}

export interface KeysResponse {
  version: "pc-keys-1";
  keys: KeyRecord[];
}

export interface HealthResponse {
  version: "pc-health-1";
  status: "ok" | "unavailable";
  protocol: "pc-request-1";
}

export interface OperationEvent {
  version: "pc-op-1";
  route: string;
  status: UInt;
  code: ErrorCode | null;
  duration_ms: UInt;
  input_bytes: UInt;
}

/* ---- Trusted in-process capabilities (never wire schemas) ---- */

export interface Signer {
  key_id: KeyId;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

export interface CheckContext {
  tenant_id: TenantId;
  contract: Contract;
  as_of: Time;
  signer: Signer;
  receipt_keys: KeyRecord[];
  next_entry_id: () => EntryId;
  signal: { aborted: boolean };
  /** Test-harness hooks (trusted, in-process; never accepted from wire input). */
  monotonic_ms?: (() => number) | undefined;
  deadline_ms?: number | undefined;
  /** Aggregate timing sink for pc_source_parse_ms / pc_sign_ms observations. */
  timings?: { observe: (name: "pc_source_parse_ms" | "pc_sign_ms", ms: number) => void } | undefined;
}

export interface TrustContext {
  tenant_id: TenantId;
  contract_hash: Hash;
  receipt_keys: KeyRecord[];
  now: Time;
  purpose: "delivery" | "historical";
}

export interface BeforeSendInput {
  run_id: RunId;
  draft: string;
  retrieval: Retrieval;
}

export interface BeforeSendResult {
  package: Package;
  delivery: RenderResult;
}
