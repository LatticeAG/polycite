import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "@latticeag/polycite-core";

/**
 * File IO rules (§12–13): strict UTF-8 inputs, `--input -` reads stdin once,
 * outputs are exclusive-create via temp-write + fsync + no-replace hard-link
 * publication, seed files must be regular non-symlink owner-only files.
 */

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 23) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function readInputBytes(input: string, cwd: string): Uint8Array<ArrayBuffer> {
  if (input === "-") {
    return new Uint8Array(fs.readFileSync(0));
  }
  const p = path.resolve(cwd, input);
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    throw new CliError(`input not found: ${input}`, 23);
  }
  if (!st.isFile()) throw new CliError(`input is not a regular file: ${input}`, 23);
  return new Uint8Array(fs.readFileSync(p));
}

export function readInputText(input: string, cwd: string): string {
  const bytes = readInputBytes(input, cwd);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliError(`input is not valid UTF-8: ${input}`, 20);
  }
}

/**
 * Exclusive-create publication: private temp file in the destination dir,
 * full write, fsync, then a no-replace hard link. An existing target is an
 * error (exit 23); no implicit overwrite exists.
 */
export function writeExclusive(outPath: string, bytes: Uint8Array, mode: number, cwd: string): void {
  const dest = path.resolve(cwd, outPath);
  const dir = path.dirname(dest);
  if (!fs.existsSync(dir)) throw new CliError(`output directory does not exist: ${dir}`, 23);
  if (fs.existsSync(dest)) throw new CliError(`output path already exists: ${outPath}`, 23);
  const tmpName = `.pc-${process.pid}-${[...randomBytes(8)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const tmpPath = path.join(dir, tmpName);
  let fd: number;
  try {
    fd = fs.openSync(tmpPath, "wx", 0o600);
  } catch {
    throw new CliError(`cannot create temporary file in ${dir}`, 23);
  }
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.linkSync(tmpPath, dest);
  } catch (e) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best effort */
    }
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliError(`output path already exists: ${outPath}`, 23);
    throw new CliError(`cannot publish ${outPath}: ${(e as Error).message}`, 23);
  }
  fs.unlinkSync(tmpPath);
}

export function readSeedFile(p: string): Uint8Array {
  const abs = path.resolve(p);
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    throw new CliError(`seed file not found: ${p}`, 23);
  }
  if (lst.isSymbolicLink() || !lst.isFile())
    throw new CliError(`seed file must be a regular non-symlink file: ${p}`, 23);
  if ((lst.mode & 0o077) !== 0)
    throw new CliError(`seed file has group/other permissions: ${p}`, 23);
  const uid = typeof process.getuid === "function" ? process.getuid() : lst.uid;
  if (lst.uid !== uid) throw new CliError(`seed file not owned by invoking user: ${p}`, 23);
  return new Uint8Array(fs.readFileSync(abs));
}
