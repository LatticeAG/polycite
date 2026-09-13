import type {
  BeforeSendInput,
  CheckContext,
  JsonError,
  Package,
  TrustContext,
} from "@latticeag/polycite-core";
import { beforeSend, isJsonError, render, verifyPackage } from "./sdk.js";

/**
 * PolyBrain boundary adapter (§2.2). Installed at the final egress hook —
 * after the complete draft is buffered, before any byte reaches an end user.
 * The hook yields only canonical render output; `null` means withhold.
 * A caller that emits its own draft or strips markers bypasses the boundary
 * (accepted risk AR-02).
 */
export interface BoundaryDelivery {
  /** Canonical render text to send, or null when the answer is withheld. */
  text: string | null;
  /** The complete signed audit package for access-controlled storage. */
  package: Package;
}

export interface PolyBrainBoundary {
  beforeSend(input: BeforeSendInput): Promise<BoundaryDelivery | JsonError>;
  /** Re-validate a stored package immediately before send; detects any
   *  mutation after the initial check. */
  validateForSend(pkg: Package): Promise<{ text: string | null } | JsonError>;
}

export function createPolyBrainBoundary(
  context: CheckContext,
  trust: TrustContext,
): PolyBrainBoundary {
  return {
    async beforeSend(input) {
      const r = await beforeSend(input, context, trust);
      if (isJsonError(r)) return r;
      // The adapter independently validates the returned package.
      const v = await verifyPackage(r.package, trust);
      if (!v.valid) return v.failure;
      return { text: r.delivery.text, package: r.package };
    },
    async validateForSend(pkg) {
      const v = await verifyPackage(pkg, trust);
      if (!v.valid) return v.failure;
      const d = await render(pkg, trust);
      if (isJsonError(d)) return d;
      return { text: d.text };
    },
  };
}
