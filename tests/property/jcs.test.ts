import { describe, expect, it } from "vitest";
import { canonicalize, J } from "../../packages/core/dist/index.js";
import { pick, rng } from "./helpers.js";

/** §18 canonicalization: RFC 8785 vectors plus generated-object agreement
 *  against an independent sorted-keys JSON.stringify reference (ASCII keys,
 *  integer values — the fixture-serializer domain). */

// RFC 8785 §A style vectors: [input JS value, expected canonical string]
const VECTORS: [unknown, string][] = [
  [{}, "{}"],
  [[], "[]"],
  [{ b: 2, a: 1 }, '{"a":1,"b":2}'],
  [{ "10": "b", "2": "a", "1": "e" }, '{"1":"e","10":"b","2":"a"}'],
  [{ "€": "x", "\r": "y", "1": "z" }, '{"\\r":"y","1":"z","€":"x"}'],
  [{ a: { d: [3, 2, 1], b: "x" }, c: null }, '{"a":{"b":"x","d":[3,2,1]},"c":null}'],
  [[1, "a", true, false, null], '[1,"a",true,false,null]'],
  [{ n: 0 }, '{"n":0}'],
  [{ n: 9007199254740991 }, '{"n":9007199254740991}'],
  [{ s: "a\tb\nc" }, '{"s":"a\\tb\\nc"}'],
  [{ s: "é中😀" }, '{"s":"é中😀"}'],
  [{ "😀": 1, z: 2 }, '{"z":2,"😀":1}'],
  [1.5, "1.5"],
  [1e21, "1e+21"],
  [-0.5, "-0.5"],
];

// Independent reference: sorted-key JSON.stringify (valid RFC8785 for
// ASCII-keyed integer-only objects — the domain of every wire fixture).
function refJcs(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
      : x,
  );
}

describe("JCS canonicalization", () => {
  it("official-style vectors", () => {
    for (const [input, expected] of VECTORS) {
      expect(canonicalize(input)).toBe(expected);
      expect(Buffer.from(J(input)).toString()).toBe(expected);
    }
  });

  it("10000 generated in-schema objects agree with reference", () => {
    const r = rng(0x123456789abcdefn);
    const keys = ["a", "b", "x1", "y2", "z3", "kk", "mm", "nn"];
    const genVal = (depth: number): unknown => {
      const t = Number(r() % (depth > 3 ? 4n : 7n));
      if (t === 0) return Number(r() % 1000000n);
      if (t === 1) return pick(r, ["alpha", "beta", "gamma", "δelta".replace("δ", "d")]);
      if (t === 2) return r() % 2n === 0n;
      if (t === 3) return null;
      if (t === 4) {
        const o: Record<string, unknown> = {};
        const n = Number(r() % 6n);
        for (let i = 0; i < n; i++) o[pick(r, keys) + i] = genVal(depth + 1);
        return o;
      }
      const a: unknown[] = [];
      const n = Number(r() % 5n);
      for (let i = 0; i < n; i++) a.push(genVal(depth + 1));
      return a;
    };
    for (let i = 0; i < 10000; i++) {
      const v = genVal(0);
      expect(canonicalize(v)).toBe(refJcs(v));
    }
  });
});
