#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dispatch } from "./commands.js";
import { UsageError } from "./args.js";
import { CliError } from "./fsio.js";

// pnpm replaces INIT_CWD in lifecycle scripts. On Linux recover the value
// explicitly supplied to the invoking pnpm process, if one exists.
function callerCwd(): string | undefined {
  if (process.env.npm_execpath && process.platform === "linux") {
    try {
      const shellStat = readFileSync(`/proc/${process.ppid}/stat`, "utf8");
      const parent = Number(shellStat.slice(shellStat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmd = readFileSync(`/proc/${parent}/cmdline`, "utf8").split("\0");
      if (cmd.some((part) => /(?:^|\/)pnpm(?:\.cjs|\.js)?$/.test(part))) {
        const entry = readFileSync(`/proc/${parent}/environ`, "utf8").split("\0")
          .find((part) => part.startsWith("INIT_CWD="));
        if (entry) return entry.slice("INIT_CWD=".length);
      }
    } catch { /* procfs may be unavailable; use pnpm's value */ }
  }
  return process.env.INIT_CWD;
}

const caller = callerCwd();
const jsonMode = process.argv.slice(2).includes("--json");
const io = {
  stdout: (s: string) => process.stdout.write(s),
  stderr: (s: string) => process.stderr.write(s + (s.endsWith("\n") ? "" : "\n")),
  jsonMode,
  quiet: process.argv.slice(2).includes("--quiet"),
  cwd: process.cwd(),
  ...(caller ? { callerCwd: caller } : {}),
};

try {
  const code = await dispatch(process.argv.slice(2), io);
  process.exit(code);
} catch (e) {
  if (e instanceof UsageError || e instanceof CliError) {
    const msg = (e as Error).message;
    io.stderr(jsonMode ? `{"error":${JSON.stringify(msg)}}` : `polycite: ${msg}`);
    process.exit(e instanceof CliError ? e.exitCode : 23);
  }
  io.stderr(`polycite: internal failure: ${(e as Error).message}`);
  process.exit(24);
}
