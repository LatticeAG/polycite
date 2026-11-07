import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../packages/cli/src/args.js";

describe("CLI arguments", () => {
  it("prints only the version", () => {
    expect(execFileSync(process.execPath, ["packages/cli/dist/main.js", "--version"], { encoding: "utf8" })).toBe("1.0.0\n");
  });

  it("explains where to put config when it precedes a command", () => {
    expect(parseArgs(["--config", "polycite.json", "seal"], {})).toEqual({
      command: ["seal"], flags: new Map([["config", "polycite.json"]]),
    });
  });
});
