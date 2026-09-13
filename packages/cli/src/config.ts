import * as fs from "node:fs";
import * as path from "node:path";
import {
  base64urlEncode,
  decodeSeed,
  ed25519PublicFromSeed,
  hashHex,
  J,
  parseJsonBytes,
  seedSigner,
  vConfig,
  type Config,
  type Signer,
} from "@latticeag/polycite-core";
import { CliError, readSeedFile } from "./fsio.js";

/** Loaded config plus resolved-path context. */
export interface LoadedConfig {
  config: Config;
  dir: string;
}

/** Load and fully validate the local configuration (§12.1). */
export async function loadConfig(configPath: string, cwd: string): Promise<LoadedConfig> {
  const abs = path.resolve(cwd, configPath);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(abs));
  } catch {
    throw new CliError(`config not found: ${configPath}`, 23);
  }
  let value: unknown;
  try {
    value = parseJsonBytes(bytes);
  } catch {
    throw new CliError(`config is not valid strict JSON: ${configPath}`, 23);
  }
  try {
    vConfig(value, "");
  } catch (e) {
    const fe = e as { json?: { error: { path: string } } };
    throw new CliError(`config invalid at ${fe.json?.error.path ?? ""}`, 23);
  }
  const config = value as unknown as Config;

  // Configured retrieval and receipt key IDs and public-key bytes are disjoint.
  const receiptIds = new Set(config.receipt_keys.map((k) => k.key_id));
  const receiptPubs = new Set(config.receipt_keys.map((k) => k.public_key));
  for (const rk of config.contract.retrieval_keys) {
    if (receiptIds.has(rk.key_id) || receiptPubs.has(rk.public_key))
      throw new CliError("config invalid: retrieval and receipt keys must be disjoint", 23);
  }
  const pubSeen = new Set<string>();
  for (const rk of config.contract.retrieval_keys) {
    if (pubSeen.has(rk.public_key)) throw new CliError("config invalid: duplicate public key", 23);
    pubSeen.add(rk.public_key);
  }
  for (const rk of config.receipt_keys) {
    if (pubSeen.has(rk.public_key)) throw new CliError("config invalid: duplicate public key", 23);
    pubSeen.add(rk.public_key);
  }
  if (config.local_signer !== null && !receiptIds.has(config.local_signer.key_id))
    throw new CliError("config invalid: local_signer key_id is not a configured receipt key", 23);

  return { config, dir: path.dirname(abs) };
}

/** Build the local receipt Signer from config.local_signer (seed file). */
export async function localSignerFromConfig(loaded: LoadedConfig): Promise<Signer> {
  const ls = loaded.config.local_signer;
  if (ls === null) throw new CliError("no local signer configured", 23);
  const seedPath = path.resolve(loaded.dir, ls.seed_file);
  const seedBytes = readSeedFile(seedPath);
  const seed = decodeSeed(new TextDecoder().decode(seedBytes));
  if (seed === null) throw new CliError(`seed file is not a valid 32-byte seed: ${ls.seed_file}`, 23);
  const record = loaded.config.receipt_keys.find((k) => k.key_id === ls.key_id);
  if (!record) throw new CliError("local signer key_id is not a configured receipt key", 23);
  const derived = await ed25519PublicFromSeed(seed);
  if (base64urlEncode(derived) !== record.public_key)
    throw new CliError("local signer seed does not match its configured public key", 23);
  return seedSigner(ls.key_id, seed);
}

/** Resolve the seal --key seed against configured retrieval keys by public key. */
export async function resolveRetrievalKey(
  loaded: LoadedConfig,
  keyPath: string,
  cwd: string,
): Promise<{ key_id: string; seed: Uint8Array }> {
  const abs = path.resolve(cwd, keyPath);
  const seedBytes = readSeedFile(abs);
  const seed = decodeSeed(new TextDecoder().decode(seedBytes));
  if (seed === null) throw new CliError(`key file is not a valid 32-byte seed: ${keyPath}`, 23);
  const pub = await ed25519PublicFromSeed(seed);
  const pubB64 = base64urlEncode(pub);
  const matches = loaded.config.contract.retrieval_keys.filter((k) => k.public_key === pubB64);
  if (matches.length !== 1)
    throw new CliError("seal key does not match exactly one configured retrieval key", 23);
  return { key_id: matches[0]!.key_id, seed };
}

export async function contractHashOf(loaded: LoadedConfig): Promise<string> {
  return hashHex(J(loaded.config.contract));
}
