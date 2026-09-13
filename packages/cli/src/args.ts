/** CLI flag parser. Usage errors are reported via UsageError -> exit 23. */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface ParsedArgs {
  command: string[];
  flags: Map<string, string | true>;
}

const GLOBAL_FLAGS = new Set(["config", "json", "quiet", "help", "version"]);

export function parseArgs(argv: string[], flagSpec: Record<string, Set<string>>): ParsedArgs {
  const command: string[] = [];
  const flags = new Map<string, string | true>();
  let i = 0;
  // leading non-flag tokens are the command path
  while (i < argv.length && !argv[i]!.startsWith("--")) {
    command.push(argv[i]!);
    i++;
  }
  const allowed = new Set([...GLOBAL_FLAGS, ...(flagSpec[command.join(" ")] ?? new Set())]);
  const singleValue = new Set(["config", "input", "out", "key", "public-out", "at"]);
  const booleanFlags = new Set(["json", "quiet", "help", "version", "hosted"]);

  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new UsageError(`unexpected positional argument: ${a}`);
    const eq = a.indexOf("=");
    const name = a.slice(2, eq === -1 ? undefined : eq);
    if (!allowed.has(name)) throw new UsageError(`unknown flag: --${name}`);
    if (flags.has(name)) throw new UsageError(`repeated flag: --${name}`);
    if (booleanFlags.has(name)) {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    if (!singleValue.has(name)) throw new UsageError(`unknown flag: --${name}`);
    let value: string;
    if (eq !== -1) {
      value = a.slice(eq + 1);
    } else {
      i++;
      if (i >= argv.length) throw new UsageError(`missing value for --${name}`);
      value = argv[i]!;
    }
    flags.set(name, value);
  }
  return { command, flags };
}

export function flagValue(flags: Map<string, string | true>, name: string): string | undefined {
  const v = flags.get(name);
  return typeof v === "string" ? v : undefined;
}

export function flagOn(flags: Map<string, string | true>, name: string): boolean {
  return flags.get(name) === true;
}
