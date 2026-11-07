import { expect, it } from "vitest";
import { alignFact, buildSourceIndex, summarizeFact } from "../../packages/core/src/align.js";
import { parseFact } from "../../packages/core/src/grammar.js";
import type { Source } from "../../packages/core/src/types.js";

it("preserves counts and ordered links when evidence exceeds the link limit", () => {
  const source = (id: string, text: string): Source => ({
    source_id: id, kind: "text", authority: "acme", role: "primary", origin: "urn:test",
    extraction: "standalone", text, content_hash: "",
  });
  const index = buildSourceIndex([
    source("b", Array.from({ length: 10 }, (_, i) => `Acme revenue for 2024 is ${i % 2 ? "1.0" : "2"} USD.`).join("\n")),
    source("a", "Acme revenue for 2024 is 1 USD.\nAcme revenue for 2024 is 3 USD."),
  ]);
  for (const text of ["Acme revenue for 2024 is 1 USD", "Acme revenue for 2024 is 4 USD"]) {
    const parsed = parseFact(text);
    if (!parsed.ok) throw new Error("invalid fixture");
    const full = alignFact(index, parsed.fact);
    const summary = summarizeFact(index, parsed.fact, 4);
    expect(summary.supports).toEqual(full.supports.slice(0, 4));
    expect(summary.contradicts).toEqual(full.contradicts.slice(0, 4));
    expect(summary.totalSupports).toBe(full.supports.length);
    expect(summary.totalContradicts).toBe(full.contradicts.length);
  }
});
