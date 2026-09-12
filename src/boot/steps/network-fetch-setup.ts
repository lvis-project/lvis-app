import type { BootContext } from "../context.js";

export async function setupNetworkFetch(ctx: BootContext): Promise<void> {
  ctx.networkFetch = ctx.host.networkFetch;
  ctx.singleHopNetworkFetch = ctx.host.singleHopNetworkFetch;
  ctx.llmFetch = ctx.host.llmFetch;
}
