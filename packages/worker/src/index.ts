export { createWorker } from "./handler.js";
export type { WorkerEnv, WorkerHarness, WorkerHandle } from "./handler.js";
export { Metrics, operationEvent } from "./metrics.js";
export { RateLimiter } from "./limiter.js";
export {
  NotImplementedHostedError,
  provisionHostedDeployment,
  rotateHostedCredentials,
  hostedBillingExport,
} from "./hosted.js";

import { createWorker, type WorkerEnv } from "./handler.js";

/**
 * Cloudflare Workers entry point: `fetch` is bound at module scope with the
 * deployment environment (PC_PUBLIC_CONFIG, PC_SIGNING_SEED, PC_SIGNING_KEY_ID,
 * PC_AUTH_BINDINGS). The handler contains no networking beyond the request,
 * no fetch of user locators, and no model calls.
 */
const worker = {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return createWorker(env).fetch(request);
  },
};

export default worker;
