import { describe, expect, it } from "vitest";
import { splitCandidates, U } from "../../packages/core/dist/index.js";
import { pick, rng } from "./helpers.js";

/** §18 span properties: 10000 generated Unicode drafts; every non-whitespace
 *  byte is covered exactly once and every span is on code-point boundaries. */
describe("span coverage property", () => {
  const pool = [
    "a", "B", "z", "0", "9", " ", ".", "?", "!", ";", "\n", "\r", "\t",
    "é", "中", "\u{1f600}", "€", "'", '"', "(", ")", "-", "_",
  ];

  it("10000 random drafts: coverage exactly once, boundaries valid", () => {
    const r = rng(0x9e3779b97f4a7c15n);
    for (let iter = 0; iter < 10000; iter++) {
      const n = Number(r() % 60n);
      let draft = "";
      for (let i = 0; i < n; i++) draft += pick(r, pool);
      if (!/[^\x20\t\n\r]/.test(draft)) continue; // skip all-whitespace drafts (EMPTY_DRAFT domain)
      const bytes = U(draft);
      const cands = splitCandidates(draft);
      const covered = new Uint8Array(bytes.length);
      for (const c of cands) {
        expect(c.span.start).toBeLessThan(c.span.end);
        // boundaries are on code point boundaries: decode must not throw
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(c.span.start, c.span.end));
        for (let i = c.span.start; i < c.span.end; i++) {
          covered[i]!++;
        }
      }
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!;
        const ws = b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
        if (ws) {
          // whitespace may be interior (covered once) or edge/separator (uncovered)
          expect(covered[i]).toBeLessThanOrEqual(1);
        } else {
          expect(covered[i]).toBe(1);
        }
      }
    }
  });
});
