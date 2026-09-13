import type { ErrorCode, OperationEvent, UInt } from "@latticeag/polycite-core";

/**
 * §15 observability: aggregate counters and fixed-bucket histograms. Labels
 * come from fixed enums only — never source IDs, run IDs, tenant IDs, hashes,
 * origins, or claim text.
 */

const MS_BUCKETS = [1, 5, 10, 25, 50, 100, 150, 250, 500, 1000, 2000];
const BYTE_BUCKETS = [1024, 4096, 16384, 65536, 262144, 393216, 2097152];
const CLAIM_BUCKETS = [1, 4, 16, 32, 64, 128];

type Labels = Record<string, string | number>;

function keyOf(name: string, labels: Labels): string {
  const ks = Object.keys(labels).sort();
  return name + "|" + ks.map((k) => `${k}=${labels[k]}`).join(",");
}

export class Metrics {
  private counters = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  inc(name: string, labels: Labels, by = 1): void {
    const k = keyOf(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  observe(name: string, buckets: number[], value: number): void {
    const arr = this.histograms.get(name) ?? new Array(buckets.length + 1).fill(0);
    let placed = false;
    for (let i = 0; i < buckets.length; i++) {
      if (value <= buckets[i]!) {
        arr[i]!++;
        placed = true;
        break;
      }
    }
    if (!placed) arr[buckets.length]!++;
    this.histograms.set(name, arr);
  }

  observeMs(name: string, ms: number): void {
    this.observe(name, MS_BUCKETS, ms);
  }

  observeBytes(name: string, bytes: number): void {
    this.observe(name, BYTE_BUCKETS, bytes);
  }

  observeClaims(name: string, claims: number): void {
    this.observe(name, CLAIM_BUCKETS, claims);
  }

  snapshot(): { counters: Record<string, number>; histograms: Record<string, number[]> } {
    return {
      counters: Object.fromEntries(this.counters),
      histograms: Object.fromEntries(this.histograms),
    };
  }
}

export interface RequestMeta {
  route: string;
  status: UInt;
  code: ErrorCode | null;
  duration_ms: UInt;
  input_bytes: UInt;
}

/** Content-free operational event; sampled by log_sample_ppm. */
export function operationEvent(m: RequestMeta): OperationEvent {
  return {
    version: "pc-op-1",
    route: m.route,
    status: m.status,
    code: m.code,
    duration_ms: Math.floor(m.duration_ms),
    input_bytes: m.input_bytes,
  };
}
