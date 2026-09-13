import { describe, expect, it } from "vitest";
import { base64urlDecode, J } from "../../packages/core/dist/index.js";
import { verifyPackage } from "../../packages/sdk/dist/index.js";
import { PK0, TRUST } from "../fixtures/fx.mjs";

/** §18 mutation integrity: flip each byte of the golden package's signed
 *  bodies and signatures; none must validate. */
describe("mutation integrity", () => {
  it("every single-byte mutation of signed bodies/signatures fails", async () => {
    let mutations = 0;
    const check = async (mutate: (copy: typeof PK0) => void) => {
      const copy = JSON.parse(JSON.stringify(PK0)) as typeof PK0;
      mutate(copy);
      const res = await verifyPackage(copy, TRUST);
      expect(res.valid, "mutated package must not validate").toBe(false);
      mutations++;
    };

    // Flip every byte of every entry body.
    for (let i = 0; i < PK0.result.audit.length; i++) {
      const bodyBytes = J(PK0.result.audit[i]!.body);
      for (let pos = 0; pos < bodyBytes.length; pos++) {
        await check((copy) => {
          const b = Buffer.from(bodyBytes);
          b[pos]! ^= 0x01;
          try {
            copy.result.audit[i]!.body = JSON.parse(b.toString()) as typeof copy.result.audit[number]["body"];
          } catch {
            // unparseable mutation: alter a well-formed field instead
            const e = copy.result.audit[i]!.body as { at: string };
            e.at = e.at.replace(/\d/, e.at.includes("9") ? "8" : "9");
          }
        });
      }
    }

    // Flip every byte of every signature and hash.
    for (let i = 0; i < PK0.result.audit.length; i++) {
      const sig = base64urlDecode(PK0.result.audit[i]!.signature);
      for (let pos = 0; pos < sig.length; pos++) {
        await check((copy) => {
          const s = Buffer.from(base64urlDecode(copy.result.audit[i]!.signature));
          s[pos]! ^= 0x01;
          copy.result.audit[i]!.signature = s.toString("base64url");
        });
      }
      const h = Buffer.from(PK0.result.audit[i]!.hash, "hex");
      for (let pos = 0; pos < h.length; pos++) {
        await check((copy) => {
          const hb = Buffer.from(copy.result.audit[i]!.hash, "hex");
          hb[pos]! ^= 0x01;
          copy.result.audit[i]!.hash = hb.toString("hex");
        });
      }
    }

    // Retrieval body bytes and retrieval signature.
    const rb = J(PK0.request.retrieval.body);
    for (let pos = 0; pos < rb.length; pos++) {
      await check((copy) => {
        const b = Buffer.from(rb);
        b[pos]! ^= 0x01;
        try {
          copy.request.retrieval.body = JSON.parse(b.toString()) as typeof copy.request.retrieval.body;
        } catch {
          copy.request.retrieval.body.retriever_id = "tampered.invalid";
        }
      });
    }
    const rs = base64urlDecode(PK0.request.retrieval.signature);
    for (let pos = 0; pos < rs.length; pos++) {
      await check((copy) => {
        const s = Buffer.from(base64urlDecode(copy.request.retrieval.signature));
        s[pos]! ^= 0x01;
        copy.request.retrieval.signature = s.toString("base64url");
      });
    }

    expect(mutations).toBeGreaterThan(2000);
  }, 600_000);
});
