#!/usr/bin/env node
import { dispatch } from "./commands.js";
import { UsageError } from "./args.js";
import { CliError } from "./fsio.js";

const jsonMode = process.argv.slice(2).includes("--json");
const io = {
  stdout: (s: string) => process.stdout.write(s),
  stderr: (s: string) => process.stderr.write(s + (s.endsWith("\n") ? "" : "\n")),
  jsonMode,
  quiet: process.argv.slice(2).includes("--quiet"),
  cwd: process.cwd(),
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
