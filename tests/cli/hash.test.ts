import { expect, it } from "vitest";
import { hashHex } from "../../packages/core/src/crypto.js";

it("rejects serializing an unawaited hash instead of silently writing an invalid receipt", async () => {
  const pending = hashHex(new TextEncoder().encode("x"));
  expect(() => JSON.stringify({ content_hash: pending })).toThrow(/await hashHex/);
  expect(await pending).toBe("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881");
});
