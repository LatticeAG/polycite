/**
 * Generates cross-runtime interop artifacts consumed by tests/interop.
 * Everything written here is derived from public fixture material only.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, splitCandidates, U } from "../../packages/core/dist/index.js";
import { CHECKPOINTS, PK0, RS_SEED, VS_SEED } from "./fx.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "interop", "fixtures");
mkdirSync(OUT, { recursive: true });

const write = (name, value) =>
  writeFileSync(join(OUT, name), JSON.stringify(value, null, 2) + "\n");

write("package.json", PK0);
write("checkpoints.json", CHECKPOINTS);
write("seeds.json", {
  retrieval_seed_hex: Buffer.from(RS_SEED).toString("hex"),
  receipt_seed_hex: Buffer.from(VS_SEED).toString("hex"),
});

/** JCS vectors: input JSON text -> expected canonical output from the TS impl. */
const JCS_INPUTS = [
  {},
  { b: 2, a: 1 },
  { "10": "b", "2": "a", "1": "e" },
  { "€": "x", "\r": "y", "1": "z" },
  { a: { d: [3, 2, 1], b: "x" }, c: null },
  [1, "a", true, false, null],
  { n: 0 },
  { n: 9007199254740991 },
  { s: "a\tb\nc" },
  { s: "é中😀" },
  { "😀": 1, z: 2 },
  1.5,
  -0.5,
  1e21,
  { nested: { arr: [{ z: 1, a: 2 }], s: "x" }, list: [true, null, "q"] },
  { k: "quote\"backslash\\ctrl" },
];
write(
  "jcs.json",
  JCS_INPUTS.map((v) => ({ input: JSON.stringify(v), canonical: canonicalize(v) })),
);

/** Span vectors: drafts -> expected candidate byte spans from the TS splitter. */
const SPAN_DRAFTS = [
  "Acme is a company.",
  "Acme is a company. Beta is a star.",
  "  Acme is a company.  ",
  "Acme is a company.\nBeta is a star.\n",
  "Café is a company. 中 is a city.",
  "😀 Co is a company.  It's fine.",
  "One; two; three.",
  "Line one.\r\nLine two.",
];
write(
  "spans.json",
  SPAN_DRAFTS.map((draft) => ({
    draft,
    utf8_hex: Buffer.from(U(draft)).toString("hex"),
    spans: splitCandidates(draft).map((c) => c.span),
  })),
);

console.log("wrote interop fixtures to", OUT);
