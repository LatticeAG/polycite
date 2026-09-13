/**
 * Hosted/paid operations that are intentionally NOT part of the MIT package.
 * These are documented stub interfaces: they throw NotImplemented with a link
 * rather than pretending to work. The fetch handler (handler.ts) is the real
 * verification surface; these operations are deployment provisioning concerns.
 */

const DOCS = "https://github.com/LatticeAG/polycite#hosted-verification";

export class NotImplementedHostedError extends Error {
  readonly docs = DOCS;
  constructor(op: string) {
    super(`NotImplemented: ${op} is a hosted LatticeAG operation, not an OSS API. See ${DOCS}`);
    this.name = "NotImplementedHostedError";
  }
}

/** Provision a paid hosted deployment (secret bindings, TLS, tenant tokens). */
export function provisionHostedDeployment(): never {
  throw new NotImplementedHostedError("provisionHostedDeployment");
}

/** Rotate hosted bearer credentials / receipt signing keys. */
export function rotateHostedCredentials(): never {
  throw new NotImplementedHostedError("rotateHostedCredentials");
}

/** Hosted usage/billing export — no such surface exists in this package. */
export function hostedBillingExport(): never {
  throw new NotImplementedHostedError("hostedBillingExport");
}
