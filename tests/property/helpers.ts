/** Deterministic xorshift64 PRNG for reproducible property tests. */
export function rng(seed: bigint): () => bigint {
  let s = seed;
  return () => {
    s ^= s << 13n;
    s &= 0xffffffffffffffffn;
    s ^= s >> 7n;
    s ^= s << 17n;
    s &= 0xffffffffffffffffn;
    return s;
  };
}

export function pick<T>(r: () => bigint, xs: readonly T[]): T {
  return xs[Number(r() % BigInt(xs.length))]!;
}
