/**
 * Ollama local-model availability probe (#1498 — no-key onboarding).
 *
 * A user without a demo activation key or a BYOK API key (off the internal
 * network, remote/home, or an external evaluator) can still get a first
 * value-experience if they already run Ollama locally. This module owns the
 * single question "is a local Ollama server reachable right now" so the
 * login modal can conditionally offer a "start with a local model" CTA
 * without ever showing it when nothing is actually listening — an
 * unconditional CTA would be misleading (the vendor preset's baseUrl always
 * exists in `llm-vendor-defaults.ts`; only the probe proves reachability).
 *
 * Probe target: `GET http://localhost:11434/api/tags` — Ollama's own
 * lightweight model-list endpoint, used only as a liveness check here (the
 * response body is not inspected). ~500ms timeout via AbortController so a
 * cold/absent daemon never stalls the login modal's status check.
 */
import { createLogger } from "../lib/logger.js";

const log = createLogger("ollama-probe");

const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
const OLLAMA_PROBE_TIMEOUT_MS = 500;

/**
 * Test seam. `undefined` (the default) means "run the real network probe";
 * a boolean short-circuits to that value without touching the network.
 * Mirrors the `_setEmbeddedActivationCodeForTest` convention in
 * `demo-embedded-activation.ts`.
 */
let ollamaAvailableOverrideForTest: boolean | undefined;

export function _setOllamaAvailableOverrideForTest(value: boolean | undefined): void {
  ollamaAvailableOverrideForTest = value;
}

/**
 * True when a local Ollama server answers `GET /api/tags` within the probe
 * timeout. Never throws — any network failure (connection refused, DNS,
 * timeout, non-2xx) resolves to `false` so callers can use the result
 * directly as a UI-gating boolean.
 */
export async function probeOllamaAvailable(): Promise<boolean> {
  if (ollamaAvailableOverrideForTest !== undefined) {
    return ollamaAvailableOverrideForTest;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(OLLAMA_TAGS_URL, { signal: controller.signal });
    return response.ok;
  } catch (err) {
    log.info(`ollama probe failed: ${(err as Error).message}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
