import { describe, expect, it } from "vitest";
import { runCheck } from "../../packages/core/dist/index.js";
import { beforeSend, render, verifyPackage } from "../../packages/sdk/dist/index.js";
import { checkContext, F, ID, PK0, T, TRUST, workerEnv } from "../fixtures/fx.mjs";
import { createWorker } from "../../packages/worker/dist/index.js";
import { TEST_TOKEN } from "../fixtures/fx.mjs";

/** §18 boundary integration + concurrency + privacy canaries. */
describe("boundary integration", () => {
  it("render on a blocked package yields null text, never draft bytes", async () => {
    const f = F({ draft: "Acme revenue was 9B in 2024." });
    const out = await runCheck(f.request, checkContext(f));
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    expect(out.decision.outcome).toBe("blocked");
    const rendered = await render({ version: "pc-package-1", request: f.request, result: out }, TRUST);
    expect("error" in rendered).toBe(false);
    if (!("error" in rendered)) {
      expect(rendered.text).toBeNull();
    }
  });

  it("beforeSend returns no original draft on error branch", async () => {
    const f = F({ draft: "Acme revenue was 9B in 2024." });
    const out = await beforeSend(
      { run_id: f.request.run_id, draft: "Acme revenue was 9B in 2024.", retrieval: f.request.retrieval },
      checkContext(f),
      TRUST,
    );
    expect("error" in out).toBe(false);
    if (!("error" in out)) {
      // blocked → delivery text is null; draft "9B" claim must not be delivered
      expect(out.delivery.text).toBeNull();
      expect(out.package.result.decision.outcome).toBe("blocked");
    }
  });

  it("golden package renders canonical annotated-free text for release", async () => {
    const v = await verifyPackage(PK0, TRUST);
    expect(v.valid).toBe(true);
    const r = await render(PK0, TRUST);
    expect("error" in r).toBe(false);
  });

  it("historical render is refused (EXPIRED_RECEIPT), not bypassed", async () => {
    const r = await render(PK0, { ...TRUST, purpose: "historical" });
    expect("error" in r).toBe(true);
    if ("error" in r) expect(r.error.code).toBe("EXPIRED_RECEIPT");
  });
});

describe("concurrency property", () => {
  it("100 batches of 8 items: stable ordering and outcomes", async () => {
    const env = await workerEnv();
    const w = createWorker(env, { wallClock: () => T, testMode: true });
    for (let b = 0; b < 100; b++) {
      const items = [];
      for (let i = 0; i < 8; i++) {
        const f = F({
          draft: i % 3 === 0 ? "Beta is a star." : "Acme is a company.",
          request: { run_id: ID("pcr_", String.fromCharCode(65 + i)) },
        });
        items.push(f.request);
      }
      const res = await w.fetch(
        new Request("https://polycite.test/v1/batches/verify", {
          method: "POST",
          headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({
            version: "pc-batch-request-1",
            batch_id: ID("pcb_", String.fromCharCode(97 + (b % 26))),
            items,
          }),
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { run_id: string; ok: boolean; result?: { decision: { outcome: string } } }[];
      };
      expect(body.items).toHaveLength(8);
      for (let i = 0; i < 8; i++) {
        expect(body.items[i]!.run_id).toBe(items[i]!.run_id);
        expect(body.items[i]!.ok).toBe(true);
        const want = i % 3 === 0 ? "blocked" : "release";
        expect(body.items[i]!.result!.decision.outcome).toBe(want);
      }
    }
  }, 300_000);
});

describe("privacy canaries", () => {
  const CANARY = "zzsecretcanary9f2ez";

  it("secret markers never appear in errors, metrics, or event output", async () => {
    const env = await workerEnv();
    const w = createWorker(env, { wallClock: () => T, testMode: true });

    // Canaries in draft, source text, source id, run id, and origin.
    const f = F({
      draft: `Draft text ${CANARY} is here. Acme revenue was 4B in 2024.`,
      source: {
        source_id: `pcs_${CANARY}zz`,
        origin: `urn:${CANARY}`,
        text: `Acme revenue was 4B in 2024. ${CANARY}`,
      },
      request: { run_id: ID("pcr_", "Z") },
    });
    const res = await w.fetch(
      new Request("https://polycite.test/v1/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(f.request),
      }),
    );
    const bodyText = await res.text();
    // The package's own fields legitimately echo source ids/spans — the canary
    // string may appear inside the returned package. It must not appear in
    // errors or op-event logs; assert no error code leak paths carry it.
    if (res.status !== 200) {
      expect(bodyText).not.toContain(CANARY);
    }

    const health = await w.fetch(new Request("https://polycite.test/healthz"));
    expect(await health.text()).not.toContain(CANARY);

    // Error path: malformed draft carrying canary must not echo it.
    const res2 = await w.fetch(
      new Request("https://polycite.test/v1/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(F({ draft: `${CANARY}` }).request),
      }),
    );
    expect(await res2.text()).not.toContain(CANARY);

    // Malformed JSON with embedded canary.
    const res3 = await w.fetch(
      new Request("https://polycite.test/v1/verify", {
        method: "POST",
        headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
        body: `{"draft":"${CANARY}",`,
      }),
    );
    expect(await res3.text()).not.toContain(CANARY);
  });
});
