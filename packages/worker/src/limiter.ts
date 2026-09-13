/**
 * Deployment-defined admission rate limiting (§11 leaves the policy to the
 * deployment; only the RATE_LIMITED shape and Retry-After: 1 are pinned).
 * Conservative default: a fixed 60 s window of at most 600 admitted requests
 * per tenant credential, held in isolate-local memory only.
 */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly maxPerWindow = 600,
    private readonly windowMs = 60_000,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  admit(key: string): boolean {
    const now = this.clock();
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= this.maxPerWindow) return false;
    w.count++;
    return true;
  }
}
