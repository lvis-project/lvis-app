/**
 * Cloud index adapter — the remote half of {@link HybridRetriever}.
 *
 * The host ships exactly one implementation, {@link DisabledCloudIndexAdapter},
 * and `src/boot/tools.ts` wires it unconditionally. No cloud index backend is
 * configured, so the cloud leg of every hybrid query contributes nothing.
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
   * Whether the backend can serve queries. Currently informational: hybrid
   * retrieval gates the cloud leg on its own `weights.cloud`, not on this.
   */
  isAvailable(): Promise<boolean>;
}

/**
 * The cloud leg with no backend behind it: `search()` yields nothing and
 * `isAvailable()` reports false. `HybridRetriever` still calls `search()` on
 * every query, so the empty array — not a throw — is the contract.
 */
export class DisabledCloudIndexAdapter implements CloudIndexAdapter {
  async search(_query: string, _topK: number): Promise<CloudIndexHit[]> {
    return [];
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}
