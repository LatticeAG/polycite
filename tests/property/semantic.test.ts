import { describe, expect, it } from "vitest";
import {
  evaluateDraft,
  hashHex,
  J,
  splitCandidates,
} from "../../packages/core/dist/index.js";
import type { Source } from "../../packages/core/dist/index.js";
import { pick, rng } from "./helpers.js";

const NAMES = ["Acme", "Globex", "Initech", "Umbrella", "Stark", "New York"];
const CLASSES = ["company", "planet", "star", "city", "country", "metal", "mammal"] as const;
const METRIC_UNIT: Record<string, string> = {
  revenue: "USD",
  headcount: "people",
  count: "items",
  rate: "percent",
  latency: "ms",
  temperature: "C",
};
const METRICS = Object.keys(METRIC_UNIT);
const YEARS = [2019, 2020, 2021, 2022, 2023, 2024];

function mkSource(
  id: string,
  role: "primary" | "secondary",
  text: string,
  extraction: "standalone" | "contextual" = "standalone",
): Source {
  return { source_id: id, kind: "text", authority: "acme", role, origin: "urn:test:semantic", extraction, text, content_hash: "" };
}

function numSentence(name: string, metric: string, value: string, year: number): string {
  return `${name} ${metric} for ${year} is ${value} ${METRIC_UNIT[metric]}.`;
}

function clsSentence(name: string, cls: string, negative: boolean): string {
  return `${name} is ${negative ? "not " : ""}a ${cls}.`;
}

function spansOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

/** §18 semantic safety: 500 labeled in-grammar cases; zero false supported. */
describe("semantic safety property", () => {
  const r = rng(0xabcdef1234567n);

  it("500 in-grammar cases: verdict matches evidence, never false supported", async () => {
    let supported = 0, contradicted = 0, unsupported = 0;
    for (let i = 0; i < 500; i++) {
      const numeric = r() % 2n === 0n;
      const name = pick(r, NAMES);
      const hasPrimary = r() % 4n !== 0n;
      let draft: string, srcText: string, agree: boolean;
      if (numeric) {
        const metric = pick(r, METRICS);
        const year = pick(r, YEARS);
        const trueVal = String(1 + Number(r() % 90n));
        agree = r() % 3n === 0n;
        const draftVal = agree ? trueVal : String(Number(trueVal) + 1 + Number(r() % 5n));
        srcText = numSentence(name, metric, trueVal, year);
        draft = numSentence(name, metric, draftVal, year);
      } else {
        const cls = pick(r, CLASSES);
        agree = r() % 3n === 0n;
        srcText = clsSentence(name, cls, false);
        draft = clsSentence(name, cls, !agree);
      }
      const sources: Source[] = [];
      if (hasPrimary) {
        sources.push(mkSource("pcs_p", "primary", srcText));
      } else if (r() % 2n === 0n) {
        sources.push(mkSource("pcs_s", "secondary", srcText));
      } else {
        sources.push(mkSource("pcs_c", "primary", srcText, "contextual"));
      }
      const claims = evaluateDraft(draft, sources, await hashHex(J({ v: i })));
      expect(claims).toHaveLength(1);
      const v = claims[0]!.verdict;
      if (v === "supported") {
        supported++;
        expect(hasPrimary).toBe(true);
        expect(agree).toBe(true);
      } else if (v === "contradicted") {
        contradicted++;
        expect(hasPrimary).toBe(true);
        expect(agree).toBe(false);
      } else {
        unsupported++;
        // unsupported only when the matching evidence isn't standalone-primary
        expect(hasPrimary).toBe(false);
      }
    }
    expect(supported + contradicted + unsupported).toBe(500);
    expect(contradicted).toBeGreaterThan(50);
    expect(supported).toBeGreaterThan(50);
  });

  it("contradiction precedence: contradict always beats supports", async () => {
    const name = "Acme", metric = "revenue", year = 2024;
    for (let i = 0; i < 200; i++) {
      const sources: Source[] = [
        mkSource("pcs_p1", "primary", numSentence(name, metric, "42", year)),
        mkSource("pcs_p2", "primary", numSentence(name, metric, "99", year)),
        mkSource("pcs_s", "secondary", numSentence(name, metric, "42", year)),
      ];
      const claims = evaluateDraft(numSentence(name, metric, "42", year), sources, await hashHex(J({ i })));
      expect(claims[0]!.verdict).toBe("contradicted");
      expect(claims[0]!.atoms[0]!.totals.contradicts).toBeGreaterThan(0);
      expect(claims[0]!.atoms[0]!.totals.supports).toBeGreaterThan(0);
    }
  });

  it("500 out-of-grammar cases: every candidate covered, none silently supported", async () => {
    const oog = [
      (n: number) => `The population rose to ${n}.`,
      (n: number) => `Revenue was roughly ${n} USD in 2024.`,
      (n: number) => `${n}% of users preferred Acme.`,
      (n: number) => `Acme might have revenue of ${n} USD.`,
      (n: number) => `it shipped ${n} boxes.`,
      (n: number) => `acme revenue for 2024 is ${n} USD.`,
    ];
    let covered = 0;
    for (let i = 0; i < 500; i++) {
      const draft = pick(r, oog)(i);
      const cands = splitCandidates(draft);
      const claims = evaluateDraft(
        draft,
        [mkSource("pcs_x", "primary", numSentence("Acme", "revenue", "4", 2024))],
        await hashHex(J({ i })),
      );
      expect(claims.length).toBe(cands.length);
      for (const c of claims) {
        covered++;
        expect(c.verdict).toBe("unsupported");
      }
    }
    expect(covered).toBe(500);
  });

  it("rewrite preservation: supported/contradicted conjuncts immutable, single pass", async () => {
    const { runCheck } = await import("../../packages/core/dist/index.js");
    const fx = await import("../fixtures/fx.mjs");
    for (let i = 0; i < 500; i++) {
      const name = pick(r, NAMES);
      const metric = pick(r, METRICS);
      const year = pick(r, YEARS);
      const good = numSentence(name, metric, "4", year).replace(/\.$/, "");
      const bad = numSentence(name, metric, "4", year + 50 >= 2100 ? year - 10 : year + 50);
      const badYear = year + 50 >= 2100 ? year - 10 : year + 50;
      const draft = r() % 2n === 0n ? `${good} and ${bad}` : `${bad.slice(0, -1)} and ${good}.`;
      const f = fx.F({
        draft,
        text: numSentence(name, metric, "4", year),
        contract: { rewrite: "prune", delivery: "annotate" },
      });
      const out = await runCheck(f.request, fx.checkContext(f));
      expect("error" in out).toBe(false);
      if ("error" in out) continue;
      const d = out.decision;
      if (d.rewrites.length > 0) {
        expect(out.final_text).toContain(good);
        expect(out.final_text).not.toContain(`${badYear}`);
      }
      for (const c of d.initial) {
        if (c.verdict === "supported" || c.verdict === "contradicted") {
          expect(d.rewrites.every((rw) => !spansOverlap(rw.original_span, c.span))).toBe(true);
        }
      }
    }
  }, 180_000);

  it("text-only traps: 100 control/non-text cases always rejected upstream", async () => {
    const { runCheck } = await import("../../packages/core/dist/index.js");
    const fx = await import("../fixtures/fx.mjs");
    const trapChars = ["\x00", "\x07", "\x1b", "\x7f", "\x08", "\u200b", "\ufeff", "\u202e", "\u2060", "\x0b"];
    for (let rep = 0; rep < 10; rep++) {
      for (const ch of trapChars) {
        const f = fx.F({ draft: `Acme is a company${ch}.` });
        const out = await runCheck(f.request, fx.checkContext(f));
        expect("error" in out).toBe(true);
      }
    }
  });
});
