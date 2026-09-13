/**
 * Executable fixture vocabulary (spec §9). Fixture key material is derived with
 * node:crypto exactly as the spec defines; verification under test uses the
 * implementation packages. All fixture secrets are public test material.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  J as coreJ,
  hashHex as coreHashHex,
  nanoidEntryIds,
  seedSigner,
} from "../../packages/core/dist/index.js";

export const U = (s) => Buffer.from(s, "utf8");
export const J = coreJ; // identical bytes to the spec's restricted serializer
export const H = (b) => createHash("sha256").update(b).digest("hex");
export const ID = (prefix, letter) => prefix + letter.repeat(21);
const K = (n) =>
  createPrivateKey({
    format: "der",
    type: "pkcs8",
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from(Array.from({ length: 32 }, (_, i) => n + i)),
    ]),
  });
export const RS = K(0);
export const VS = K(32);
export const RS_SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
export const VS_SEED = Uint8Array.from({ length: 32 }, (_, i) => 32 + i);
export const PUB = (k) =>
  createPublicKey(k).export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
export const RK = ID("pck_", "T");
export const VK = ID("pck_", "V");
export const TENANT = ID("pct_", "L");
export const RUN = ID("pcr_", "R");
export const SID = ID("pcs_", "A");
export const BATCH = ID("pcb_", "B");
export const T = "2026-09-12T00:00:00Z";
export const TEXT = "Acme is a company.";
export const KR = (key_id, key) => ({
  key_id,
  public_key: PUB(key),
  not_before: "2026-01-01T00:00:00Z",
  not_after: "2027-01-01T00:00:00Z",
  revoked: false,
});
export const RECEIPT_KEYS = [KR(VK, VS)];
export const C = {
  version: "pc-contract-1",
  delivery: "block",
  rewrite: "off",
  max_age_s: 900,
  future_skew_s: 60,
  splitter: "pc-split-1",
  grammar: "pc-en-1",
  retrieval_keys: [{ ...KR(RK, RS), authorities: ["acme"] }],
};
export const SOURCE = {
  source_id: SID,
  kind: "text",
  authority: "acme",
  role: "primary",
  origin: "urn:acme:filing:2025",
  extraction: "standalone",
  text: TEXT,
  content_hash: H(U(TEXT)),
};
export const BODY = { version: "pc-retrieval-1", audience: TENANT, retrieved_at: T, sources: [SOURCE] };
export const SIG = (key, domain, hash) =>
  sign(null, Buffer.concat([U(domain + "\n"), Buffer.from(hash, "hex")]), key).toString("base64url");
export const SEAL = (body) => {
  const hash = H(J(body));
  return { body, hash, key_id: RK, signature: SIG(RS, "PolyCite.retrieval.v1", hash) };
};
export const B = {
  version: "pc-request-1",
  run_id: RUN,
  contract_hash: H(J(C)),
  format: "plain",
  language: "en",
  draft: TEXT,
  retrieval: SEAL(BODY),
};
export const SP = { start: 0, end: 18 };
export const A0 = {
  index: 0,
  span: SP,
  verdict: "supported",
  reason: "MATCH",
  links: [
    {
      relation: "supports",
      source_id: SID,
      span: SP,
      content_hash: H(U(TEXT)),
      retrieval_hash: B.retrieval.hash,
    },
  ],
  totals: { supports: 1, contradicts: 0 },
};
export const CLAIMS = [{ index: 0, span: SP, verdict: "supported", reason: "ALL_SUPPORTED", atoms: [A0] }];
export const D0 = {
  version: "pc-decision-1",
  contract_hash: H(J(C)),
  retrieval_hash: B.retrieval.hash,
  as_of: T,
  original_hash: H(U(TEXT)),
  final_hash: H(U(TEXT)),
  initial: CLAIMS,
  final: CLAIMS,
  rewrites: [],
  outcome: "release",
};
export const RT0 = TEXT + " [pc:0]\n\nPolyCite ledger:\n" + Buffer.from(J(D0)).toString() + "\n";
export const PAYLOADS = [
  { kind: "accepted", request_hash: H(J(B)), contract_hash: H(J(C)), retrieval_hash: B.retrieval.hash },
  { kind: "evaluated", revision: 0, claims_hash: H(J(CLAIMS)), draft_hash: H(U(TEXT)) },
  { kind: "delivery_prepared", decision_hash: H(J(D0)), delivery_hash: H(U(RT0)), outcome: "release" },
];
export const AUDIT = [];
for (let i = 0; i < PAYLOADS.length; i++) {
  const body = {
    version: "pc-entry-1",
    entry_id: ID("pce_", String.fromCharCode(65 + i)),
    tenant_id: TENANT,
    run_id: RUN,
    sequence: i,
    at: T,
    previous_hash: i ? AUDIT[i - 1].hash : null,
    payload: PAYLOADS[i],
  };
  const hash = H(J(body));
  AUDIT.push({ body, hash, key_id: VK, signature: SIG(VS, "PolyCite.entry.v1", hash) });
}
export const E0 = {
  version: "pc-result-1",
  run_id: RUN,
  tenant_id: TENANT,
  request_hash: H(J(B)),
  contract: C,
  decision: D0,
  final_text: TEXT,
  audit: AUDIT,
  head_hash: AUDIT.at(-1).hash,
};
export const PK0 = { version: "pc-package-1", request: B, result: E0 };
export const TRUST = {
  tenant_id: TENANT,
  contract_hash: H(J(C)),
  receipt_keys: RECEIPT_KEYS,
  now: T,
  purpose: "delivery",
};
export const VALID0 = {
  valid: true,
  fresh: true,
  head_hash: E0.head_hash,
  decision_hash: H(J(D0)),
  outcome: "release",
};
export const RENDER0 = { outcome: "release", content_type: "text/plain; charset=utf-8", text: RT0 };
export const ERR = (code, path = "", retryable = false) => ({
  version: "pc-error-1",
  error: { code, path, retryable },
});
export const CHECKPOINTS = {
  contract_hash: "ffdd78c471f4c5e7e2213c5ba08911707ead422341dc46a5907b920ffa599a4c",
  content_hash: "1406a96579068a4e91384496da3bb8e0185efd003d90802d31ab23b13057c2f8",
  retrieval_hash: "967d43231821e2071deb353106b59346f86fc224cd2930e9255bad7ee1ba6d0f",
  request_hash: "699ac0e308caaf604dfa294bd1d1dcac8365f50a92d21d2ebfd9bce68662807f",
  decision_hash: "d45b8f31a01f1c612fd9c73ff823a1ad3ea464b3a3b6d09a9810248fc281b005",
  delivery_hash: "4d83914b45e344674a18255eeed6b361d56b11290bf7f7a307b33dc29fe25dde",
  head_hash: "8ca13c661e3f959336856d3150bc9135b279d425019341d8732fdfc9c9d7a610",
};

/** Sequential deterministic entry IDs A, B, C, D, E (fixture form). */
export const fixtureEntryIds = () => {
  const ids = ["A", "B", "C", "D", "E"].map((x) => ID("pce_", x));
  let i = 0;
  return () => ids[i++] ?? ID("pce_", "Z");
};

/** CheckContext for runCheck from an F() result, with counting-signer hook. */
export function checkContext(f, { signer } = {}) {
  return {
    tenant_id: TENANT,
    contract: f.contract,
    as_of: f.context.as_of,
    signer: signer ?? seedSigner(f.context.receipt_key, VS_SEED),
    receipt_keys: RECEIPT_KEYS,
    next_entry_id: fixtureEntryIds(),
    signal: { aborted: false },
  };
}

export const F = ({ draft = TEXT, text = TEXT, source = {}, extra = [], contract = {}, body = {}, request = {}, as_of = T } = {}) => {
  const c = { ...structuredClone(C), ...contract };
  const sources = [
    { ...structuredClone(SOURCE), text, ...source },
    ...extra.map((s) => ({ ...structuredClone(SOURCE), ...s })),
  ];
  for (const s of sources) s.content_hash = H(U(s.text));
  const rb = { ...structuredClone(BODY), ...body, sources };
  return {
    request: { ...structuredClone(B), draft, contract_hash: H(J(c)), retrieval: SEAL(rb), ...request },
    contract: c,
    context: {
      tenant_id: TENANT,
      as_of,
      entry_ids: ["A", "B", "C", "D", "E"].map((x) => ID("pce_", x)),
      receipt_key: VK,
    },
  };
};
export const M = (value, change) => {
  const copy = structuredClone(value);
  change(copy);
  return copy;
};
export const Q = (value) =>
  value.error
    ? { error: value.error.code, path: value.error.path }
    : {
        outcome: value.decision.outcome,
        initial: value.decision.initial.map((c) => c.verdict),
        final: value.decision.final.map((c) => c.verdict),
        reasons: value.decision.final.flatMap((c) => c.atoms.map((a) => a.reason)),
        rewrites: value.decision.rewrites.length,
        final_text: value.final_text,
      };
export const Q0 = {
  outcome: "release",
  initial: ["supported"],
  final: ["supported"],
  reasons: ["MATCH"],
  rewrites: 0,
  final_text: TEXT,
};

/** FORGED0: cryptographically valid, semantically false package. */
export const makeForged = async (pk) => {
  const p = structuredClone(pk);
  p.result.decision.initial[0].atoms[0].links[0].span = { start: 0, end: 4 };
  p.result.decision.final[0].atoms[0].links[0].span = { start: 0, end: 4 };
  p.result.audit[1].body.payload.claims_hash = H(J(p.result.decision.initial));
  const last = p.result.audit[2];
  last.body.payload.decision_hash = H(J(p.result.decision));
  last.body.payload.delivery_hash = H(
    U(TEXT + " [pc:0]\n\nPolyCite ledger:\n" + Buffer.from(J(p.result.decision)).toString() + "\n"),
  );
  for (let i = 0; i < p.result.audit.length; i++) {
    const e = p.result.audit[i];
    e.body.previous_hash = i ? p.result.audit[i - 1].hash : null;
    e.hash = H(J(e.body));
    e.signature = SIG(VS, "PolyCite.entry.v1", e.hash);
  }
  p.result.head_hash = last.hash;
  return p;
};

/** Test bearer credential: the all-zero public fixture token. */
export const TEST_TOKEN = "A".repeat(43);

/** Worker env wired to fixture material (test mode only). */
export async function workerEnv(extraBindings = []) {
  const tokenHash = await coreHashHex(U(TEST_TOKEN));
  return {
    PC_PUBLIC_CONFIG: Buffer.from(
      J({ version: "pc-worker-config-1", contract: C, receipt_keys: RECEIPT_KEYS, log_sample_ppm: 0 }),
    ).toString(),
    PC_SIGNING_SEED: Buffer.from(VS_SEED).toString("base64url"),
    PC_SIGNING_KEY_ID: VK,
    PC_AUTH_BINDINGS: JSON.stringify([
      { token_sha256: tokenHash, tenant_id: TENANT, scopes: ["keys:read", "verify"] },
      ...extraBindings,
    ]),
  };
}

export { nanoidEntryIds, seedSigner };
