/**
 * Provider Factory — always routes through VercelUnifiedProvider.
 *
 * Vercel AI SDK migration P4 (see docs/references/vercel-migration-baseline.md):
 * the per-vendor legacy providers and the feature flag have been removed.
 * `VercelUnifiedProvider` is the sole path for all supported vendors.
 *
 * The Vercel adapter pulls in 5 `@ai-sdk/*` packages plus `ai` — together the
 * single largest dead weight on main-process cold start when reviewer mode
 * is `rule`/`disabled` or no API key is configured. To keep `createProvider`
 * cheap at call time we return a thin lazy proxy whose `streamTurn` awaits
 * the adapter module on first use; subsequent calls share the cached module.
 */
import type {
  LLMProvider,
  LLMVendor,
  ProviderConfig,
  StreamEvent,
  StreamTurnParams,
} from "./types.js";

const COPILOT_BASE_URL = "https://models.github.ai/inference";

let adapterModuleP: Promise<typeof import("./vercel/adapter.js")> | null = null;
function loadAdapterModule(): Promise<typeof import("./vercel/adapter.js")> {
  if (!adapterModuleP) {
    adapterModuleP = import("./vercel/adapter.js");
  }
  return adapterModuleP;
}

class LazyVercelProvider implements LLMProvider {
  readonly vendor: LLMVendor;
  private innerP: Promise<LLMProvider> | null = null;
  constructor(private readonly config: ProviderConfig) {
    this.vendor = config.vendor;
  }
  private getInner(): Promise<LLMProvider> {
    if (!this.innerP) {
      const cfg = this.config;
      const baseUrl =
        cfg.vendor === "copilot"
          ? (cfg.baseUrl ?? COPILOT_BASE_URL)
          : cfg.baseUrl;
      this.innerP = loadAdapterModule().then(
        ({ VercelUnifiedProvider }) =>
          new VercelUnifiedProvider(
            cfg.vendor,
            cfg.apiKey,
            baseUrl,
            undefined,
            {
              vertexProject: cfg.vertexProject,
              vertexLocation: cfg.vertexLocation,
            },
          ),
      );
    }
    return this.innerP;
  }
  async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
    const inner = await this.getInner();
    yield* inner.streamTurn(params);
  }
}

export function createProvider(config: ProviderConfig): LLMProvider {
  return new LazyVercelProvider(config);
}

/** 벤더별 API 키 시크릿 키 이름 */
export function secretKeyFor(vendor: LLMVendor): string {
  return `llm.apiKey.${vendor}`;
}
