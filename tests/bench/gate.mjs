/**
 * §15 performance gate. Warm-core targets:
 *   p95 <= 150 ms at 4 KiB draft / 64 KiB sources
 *   p95 <= 1000 ms at admitted maximum (32 KiB draft / 16 x 64 KiB sources)
 *   added heap <= 48 MiB per check (informational total vs 112 MiB)
 * Prints measured stats; exits nonzero if a latency gate fails.
 */
import { performance } from "node:perf_hooks";
import { runCheck, hashHex, J, U, seedSigner, nanoidEntryIds } from "../../packages/core/dist/index.js";
import { C, KR, RK, RS, VS, VS_SEED, VK, RECEIPT_KEYS, TENANT, T, ID, H, SEAL, SOURCE, BODY } from "../fixtures/fx.mjs";

const CONJUNCTS = [
  (n) => `Acme revenue for 2024 is ${n} USD`,
  (n) => `Globex headcount for 2023 is ${n} people`,
  (n) => `Initech count for 2022 is ${n} items`,
  (n) => `Umbrella rate for 2021 is ${n} percent`,
  (n) => `Stark latency for 2020 is ${n} ms`,
  (n) => `VorTech temperature for 2019 is ${n} C`,
  (n) => `Nexon revenue for 2024 is ${n} EUR`,
  (n) => `Polara headcount for 2022 is ${n} people`,
];

function sentence(nConjuncts, base) {
  const parts = [];
  for (let i = 0; i < nConjuncts; i++) parts.push(CONJUNCTS[i](base + i));
  return parts.join(" and ") + ".";
}

function makeDraft(targetBytes) {
  // 8-conjunct sentences ~256B each; stop at claim cap 128 or byte target.
  let out = "";
  let claims = 0;
  while (Buffer.byteLength(out) < targetBytes && claims < 128) {
    out += (out ? " " : "") + sentence(8, claims * 100);
    claims++;
  }
  while (Buffer.byteLength(out) > targetBytes) {
    const cut = out.lastIndexOf(".", out.length - 2);
    if (cut < 0) break;
    out = out.slice(0, cut + 1);
    claims--;
  }
  return { draft: out, claims };
}

function makeSourceText(targetBytes, includeMatches) {
  // Fill with numeric facts; paragraph per line.
  const lines = [];
  if (includeMatches) {
    for (let i = 0; i < 128; i++) {
      for (let c = 0; c < 8; c++) lines.push(CONJUNCTS[c](i * 100 + c) + ".");
    }
  }
  let n = 0;
  while (Buffer.byteLength(lines.join("\n")) < targetBytes) {
    lines.push(`Filler${n % 10} revenue for 2001 is ${n} USD.`);
    n++;
  }
  let text = lines.join("\n");
  while (Buffer.byteLength(text) > targetBytes) text = text.slice(0, -10);
  return text;
}

async function buildRequest(draft, sourceTexts) {
  const sources = sourceTexts.map((text, i) => ({
    ...structuredClone(SOURCE),
    source_id: ID("pcs_", String.fromCharCode(97 + i)),
    text,
    content_hash: H(U(text)),
  }));
  const body = { ...structuredClone(BODY), sources };
  return {
    version: "pc-request-1",
    run_id: ID("pcr_", "B"),
    contract_hash: H(J(C)),
    format: "plain",
    language: "en",
    draft,
    retrieval: SEAL(body),
  };
}

const ctx = {
  tenant_id: TENANT,
  contract: C,
  as_of: T,
  signer: seedSigner(VK, VS_SEED),
  receipt_keys: RECEIPT_KEYS,
  next_entry_id: nanoidEntryIds(),
  signal: { aborted: false },
};

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function bench(label, draftBytes, sourceTexts, iters, p95Target) {
  const { draft, claims } = makeDraft(draftBytes);
  const req = await buildRequest(draft, sourceTexts);
  const reqBytes = Buffer.byteLength(JSON.stringify(req));
  // warmup
  for (let i = 0; i < 3; i++) await runCheck(req, { ...ctx, next_entry_id: nanoidEntryIds() });
  const times = [];
  const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    const out = await runCheck(req, { ...ctx, next_entry_id: nanoidEntryIds() });
    const dt = performance.now() - t0;
    if ("error" in out) throw new Error(`${label}: unexpected error ${JSON.stringify(out.error)}`);
    times.push(dt);
  }
  globalThis.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  times.sort((a, b) => a - b);
  const p50 = percentile(times, 50);
  const p95 = percentile(times, 95);
  const addedMiB = Math.max(0, (heapAfter - heapBefore) / 1048576);
  console.log(
    `${label}: draft=${Buffer.byteLength(draft)}B claims=${claims} sources=${sourceTexts.length} ` +
      `req=${reqBytes}B iters=${iters} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms ` +
      `added_heap=${addedMiB.toFixed(1)}MiB`,
  );
  const ok = p95 <= p95Target && addedMiB <= 48;
  console.log(`  gate: p95<=${p95Target}ms ${p95 <= p95Target ? "PASS" : "FAIL"}; heap<=48MiB ${addedMiB <= 48 ? "PASS" : "FAIL"}`);
  return ok;
}

const src64 = makeSourceText(65536, true);
const srcs64 = [src64];

// admitted maximum: 32 KiB draft, 256 KiB total sources (4 x 64 KiB)
const maxSrcs = Array.from({ length: 4 }, () => makeSourceText(65536, true));

let ok = true;
ok = (await bench("warm 4KiB/64KiB", 4096, srcs64, 30, 150)) && ok;
ok = (await bench("admitted max 32KiB/256KiB", 32768, maxSrcs, 10, 1000)) && ok;
process.exit(ok ? 0 : 1);
