import { describe, expect, it } from "vitest";
import { createWorker } from "../../packages/worker/dist/index.js";
import {
  B,
  BATCH,
  E0,
  ERR,
  F,
  ID,
  J,
  RUN,
  T,
  TEST_TOKEN,
  U,
  workerEnv,
} from "../fixtures/fx.mjs";

const auth = { authorization: `Bearer ${TEST_TOKEN}` };
const json = { "content-type": "application/json" };

async function makeWorker(extra: Record<string, unknown> = {}) {
  const env = await workerEnv();
  return createWorker(env, {
    wallClock: () => T,
    entryIds: (() => {
      let i = 0;
      const ids = ["A", "B", "C", "D", "E"].map((x) => ID("pce_", x));
      return () => ids[i++ % ids.length]!;
    })(),
    testMode: true,
    ...extra,
  });
}

const post = (path: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  new Request(`https://polycite.test${path}`, {
    method: "POST",
    headers: { ...auth, ...json, ...headers },
    body: new Uint8Array(body) as unknown as BodyInit,
  });

describe("worker surface", () => {
  it("TV-P--42 duplicate JSON member survives neither parser", async () => {
    const w = await makeWorker();
    const body = U('{"version":"pc-request-1","version":"pc-request-1"}');
    const res = await w.fetch(post("/v1/verify", body));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(Buffer.from(J(ERR("BAD_JSON"))).toString());
  });

  it("TV-P--48 batch semantic error isolation", async () => {
    const w = await makeWorker();
    const item2 = { ...structuredClone(B), run_id: ID("pcr_", "S"), contract_hash: "0".repeat(64) };
    const body = J({ version: "pc-batch-request-1", batch_id: BATCH, items: [B, item2] });
    const res = await w.fetch(post("/v1/batches/verify", body));
    expect(res.status).toBe(200);
    const got = await res.text();
    const expected = Buffer.from(
      J({
        version: "pc-batch-result-1",
        batch_id: BATCH,
        items: [
          { run_id: RUN, ok: true, result: E0 },
          { run_id: ID("pcr_", "S"), ok: false, failure: ERR("CONTRACT_MISMATCH", "/contract_hash") },
        ],
      }),
    ).toString();
    expect(got).toBe(expected);
  });

  it("TV-P--49 duplicate batch run ID rejects before work", async () => {
    const w = await makeWorker();
    const body = J({ version: "pc-batch-request-1", batch_id: BATCH, items: [B, B] });
    const res = await w.fetch(post("/v1/batches/verify", body));
    expect(res.status).toBe(400);
    expect(await res.text()).toBe(
      Buffer.from(J(ERR("SCHEMA_INVALID", "/items/1/run_id"))).toString(),
    );
  });

  it("TV-P--60 transport size cap precedes JSON parsing", async () => {
    const w = await makeWorker();
    const body = new Uint8Array(393217).fill(0x20);
    const res = await w.fetch(post("/v1/verify", body));
    expect(res.status).toBe(413);
    expect(await res.text()).toBe(Buffer.from(J(ERR("TOO_LARGE"))).toString());
  });

  it("TV-P--66 per-item deadline is an item result", async () => {
    let call = 0;
    const w = await makeWorker({
      itemMonotonic: (i: number) => {
        // item 0: normal clock; item 1: jumps past 2000 ms after first consult
        if (i === 0) return () => performance.now() % 1000;
        return () => (call++ === 0 ? 0 : 2500);
      },
    });
    const item2 = { ...structuredClone(B), run_id: ID("pcr_", "S") };
    const body = J({ version: "pc-batch-request-1", batch_id: BATCH, items: [B, item2] });
    const res = await w.fetch(post("/v1/batches/verify", body));
    expect(res.status).toBe(200);
    const got = JSON.parse(await res.text());
    expect(got.items[0].ok).toBe(true);
    expect(got.items[1]).toEqual({
      run_id: ID("pcr_", "S"),
      ok: false,
      failure: ERR("DEADLINE_EXCEEDED", "", true),
    });
  });

  it("POST /v1/verify golden", async () => {
    const w = await makeWorker();
    const res = await w.fetch(post("/v1/verify", J(B)));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(Buffer.from(J(E0)).toString());
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("GET /v1/keys returns published receipt keys", async () => {
    const w = await makeWorker();
    const res = await w.fetch(
      new Request("https://polycite.test/v1/keys", { headers: { ...auth } }),
    );
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body.version).toBe("pc-keys-1");
    expect(body.keys.length).toBe(1);
    expect(body.keys[0].key_id).toBe(E0.audit[0].key_id);
  });

  it("GET /healthz is unauthenticated", async () => {
    const w = await makeWorker();
    const res = await w.fetch(new Request("https://polycite.test/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"protocol":"pc-request-1","status":"ok","version":"pc-health-1"}');
  });

  it("unknown route 404, wrong method 405 with Allow, OPTIONS 405", async () => {
    const w = await makeWorker();
    const r404 = await w.fetch(new Request("https://polycite.test/nope", { headers: { ...auth } }));
    expect(r404.status).toBe(404);
    const r405 = await w.fetch(new Request("https://polycite.test/v1/verify", { method: "GET", headers: { ...auth } }));
    expect(r405.status).toBe(405);
    expect(r405.headers.get("allow")).toBe("POST");
    const opt = await w.fetch(new Request("https://polycite.test/v1/verify", { method: "OPTIONS", headers: { ...auth } }));
    expect(opt.status).toBe(405);
    const optUnknown = await w.fetch(new Request("https://polycite.test/whatever", { method: "OPTIONS" }));
    expect(optUnknown.status).toBe(405);
  });

  it("unauthenticated variants: missing, duplicated, malformed", async () => {
    const w = await makeWorker();
    const r1 = await w.fetch(new Request("https://polycite.test/v1/verify", { method: "POST", body: J(B) }));
    expect(r1.status).toBe(401);
    const r2 = await w.fetch(post("/v1/verify", J(B), { authorization: "Basic x" }));
    expect(r2.status).toBe(401);
    const r3 = await w.fetch(post("/v1/verify", J(B), { authorization: "Bearer !!!" }));
    expect(r3.status).toBe(401);
  });

  it("forbidden scope: keys without keys:read", async () => {
    const { hashHex } = await import("../../packages/core/dist/index.js");
    const env = await workerEnv([
      { token_sha256: await hashHex(U("E".repeat(43))), tenant_id: ID("pct_", "M"), scopes: ["verify"] },
    ]);
    const w = createWorker(env, { wallClock: () => T, testMode: true });
    const res = await w.fetch(
      new Request("https://polycite.test/v1/keys", {
        headers: { authorization: `Bearer ${"E".repeat(43)}` },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(Buffer.from(J(ERR("FORBIDDEN"))).toString());
  });

  it("contract mismatch over HTTP is 422", async () => {
    const w = await makeWorker();
    const bad = { ...structuredClone(B), contract_hash: "0".repeat(64) };
    const res = await w.fetch(post("/v1/verify", J(bad)));
    expect(res.status).toBe(422);
    expect(await res.text()).toBe(Buffer.from(J(ERR("CONTRACT_MISMATCH", "/contract_hash"))).toString());
  });

  it("batch golden single item", async () => {
    const w = await makeWorker();
    const body = J({ version: "pc-batch-request-1", batch_id: BATCH, items: [B] });
    const res = await w.fetch(post("/v1/batches/verify", body));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      Buffer.from(
        J({ version: "pc-batch-result-1", batch_id: BATCH, items: [{ run_id: RUN, ok: true, result: E0 }] }),
      ).toString(),
    );
  });

  it("worker replays core vectors over HTTP", async () => {
    const w = await makeWorker();
    const cases: [unknown, number][] = [
      [F({ draft: "Beta is a star." }).request, 200],
      [F({ draft: " \n " }).request, 422],
      [F({ draft: "Acme is a ‮company." }).request, 422],
      [F({ draft: "| Year | Revenue |\n| 2025 | 10 |" }).request, 422],
    ];
    for (const [req, status] of cases) {
      const res = await w.fetch(post("/v1/verify", J(req)));
      expect(res.status).toBe(status);
    }
  });
});
