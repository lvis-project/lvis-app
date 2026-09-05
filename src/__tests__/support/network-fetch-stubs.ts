import { vi } from "vitest";

/**
 * The transport a suite passes when it must pass one and no request may happen.
 *
 * `fetchPublicHttpResponse` and the seams above it take their transport as a
 * required argument, so a suite that mocks the network at a higher level (the
 * guard itself, the provider SDK, the whole module) still has to hand something
 * down. This is that something, and it THROWS: if a change ever routes a real
 * request through one of those paths, the suite fails loudly instead of
 * quietly reaching the machine's network.
 *
 * Shared rather than redefined per file — `check-test-duplicates` is the gate
 * that noticed twelve identical copies, and it is right: one body, one home.
 */
export const unusedNetworkFetch: typeof fetch = () => {
  throw new Error("this suite must not issue a network request");
};

/**
 * Make the ambient `fetch` a tripwire for the rest of the test.
 *
 * A suite that hands its subject an explicit transport is asserting the
 * subject uses THAT transport. Without this, a regression that reached for
 * `globalThis.fetch` instead would leave the suite green while sending a real
 * request from the machine running it. With it, the same regression throws.
 */
export function forbidAmbientFetch(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("this code must take its transport as an argument, not the ambient fetch");
  });
}
