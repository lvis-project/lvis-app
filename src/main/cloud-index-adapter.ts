/**
 * Cloud index adapter — the remote half of {@link HybridRetriever}.
 *
 * The host ships exactly one implementation, {@link DisabledCloudIndexAdapter}.
 * `src/boot/tools.ts` constructs it on the production boot path, guarded by the
 * same condition that registers the knowledge tools at all: an installed plugin
 * advertising the `worker-client` capability. No test constructs it as a stand-in
 * for a real backend, so this is production wiring rather than a test double.
 */

/** One hit returned by a cloud index backend. */
export interface CloudIndexHit {
  source: "cloud";
  docId: string;
  docName: string;

  snippet: string;

  url?: string;

  score: number;
}

/** Contract a cloud index backend must satisfy to join hybrid retrieval. */
export interface CloudIndexAdapter {
  /** Return at most `topK` remote hits for `query`. */
  search(query: string, topK: number): Promise<CloudIndexHit[]>;

  /**
   * Whether the backend can serve queries.
   *
   * Dead surface today: nothing in `src/` outside this module's own unit test
   * calls it, because hybrid retrieval gates the cloud leg on its own
   * `weights.cloud` instead. Knip cannot see it — it is an interface member,
   * not an export — so it will not be flagged automatically. Either a real
   * backend gives it a caller or it should be deleted along with the rest of
   * the cloud leg; it must not stay a documented no-op indefinitely.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * The cloud leg with no backend behind it: `search()` yields nothing and
 * `isAvailable()` reports false.
 *
 * Nothing reaches `search()` in the shipped wiring. `src/boot/tools.ts` builds
 * {@link HybridRetriever} without a `weights` override, so `weights.cloud` is
 * `DEFAULT_HYBRID_WEIGHTS.cloud` (`0.0`) and `HybridRetriever.safeCloud()`
 * returns early without touching the adapter. Raising that weight is the only
 * thing that would call in here.
 *
 * If it ever is called, the empty array — not a throw — is the contract:
 * `safeCloud()` routes a throw into its `catch`, which logs `cloud search
 * failed`, and a backend that is switched off must not be reported as a broken
 * one. `DisabledMarketplaceFetcher` throws for the opposite reason — its callers
 * have to surface "no marketplace configured" to the user.
 */
export class DisabledCloudIndexAdapter implements CloudIndexAdapter {
  async search(_query: string, _topK: number): Promise<CloudIndexHit[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
