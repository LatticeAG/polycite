import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../packages/cli/src/args.js";

describe("CLI arguments", () => {
  it("prints only the version", () => {
    expect(execFileSync(process.execPath, ["packages/cli/dist/main.js", "--version"], { encoding: "utf8" })).toBe("1.0.0\n");
  });

  it("accepts config before a command", () => {
    expect(parseArgs(["--config", "polycite.json", "seal"], {})).toEqual({
      command: ["seal"], flags: new Map([["config", "polycite.json"]]),
    });
  });

  it("accepts an equals-form config before a nested command", () => {
    expect(parseArgs(["--config=polycite.json", "config", "check"], {})).toEqual({
      command: ["config", "check"], flags: new Map([["config", "polycite.json"]]),
    });
  });

  it("rejects a flag where a config value is required", () => {
    expect(() => parseArgs(["check", "--config", "--json"], {})).toThrow("missing value for --config");
  });

  it("finds the invoking directory config through pnpm", () => {
    const dir = mkdtempSync(join(tmpdir(), "polycite-caller-"));
    try {
      writeFileSync(join(dir, "polycite.json"), "{}");
      expect(() => execFileSync("pnpm", ["polycite", "config", "check"], {
        env: { ...process.env, INIT_CWD: dir }, encoding: "utf8", stdio: "pipe",
      })).toThrow(/config invalid/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
