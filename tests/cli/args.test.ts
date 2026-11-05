import { describe, expect, it } from "vitest";
import { parseArgs } from "../../packages/cli/src/args.js";

describe("CLI arguments", () => {
  it("explains where to put config when it precedes a command", () => {
    expect(() => parseArgs(["--config", "polycite.json", "seal"], {}))
      .toThrow("place the subcommand first: polycite seal ... --config FILE");
  });
});
