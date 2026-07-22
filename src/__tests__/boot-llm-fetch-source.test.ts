import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { readBootWiring } from "../testing/boot-wiring-source.js";

async function readSource(relative: string): Promise<string> {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

describe("boot LLM fetch wiring regression guards", () => {
  it("uses the safe Electron fetch wrapper instead of raw net.fetch", async () => {
    const bootSource = await readBootWiring();

    // path-agnostic: the createSafeLlmFetch wiring moved into a boot/steps module
    // (deeper relative path) during the C18 BootContext split.
    expect(bootSource).toMatch(/import \{ createSafeLlmFetch \} from "[^"]*safe-llm-fetch\.js";/);
    expect(bootSource).toContain("const electronNetFetch = net.fetch.bind(net);");
    expect(bootSource).toContain("const llmFetch = createSafeLlmFetch(electronNetFetch);");
    expect(bootSource).not.toContain("net.fetch.bind(net) as typeof fetch");
  });

  it("scopes Electron fetch injection to Azure Foundry providers", async () => {
    const bootSource = await readBootWiring();
    // The turn provider factory (engine/turn/provider.ts) and the reviewer
    // wiring (boot/steps/reviewer-permission-wiring.ts) both delegate runtime
    // fetch selection to the shared selectProviderRuntimeFetch (cluster M1
    // hoist). The azure-foundry Electron-fetch scoping is the single SOT inside
    // that selector, so guard it there rather than at each former inline ladder.
    const providerSource = await readSource("../engine/turn/provider.ts");
    const fetchSelectorSource = await readSource(
      "../engine/llm/marketplace-provider-fetch.ts",
    );

    // Single SOT: only azure-foundry receives the Electron main-process llmFetch.
    expect(fetchSelectorSource).toContain('vendor === "azure-foundry"');
    expect(fetchSelectorSource).toContain("? llmFetch");

    // The reviewer wiring (part of bootSource) routes through the shared
    // selector, forwarding the Electron llmFetch for only the azure branch.
    expect(bootSource).toContain("selectProviderRuntimeFetch({");

    // The turn provider factory routes through the same selector and passes the
    // Electron fetch as deps.llmFetch — no inline azure branch remains here.
    expect(providerSource).toContain("selectProviderRuntimeFetch({");
    expect(providerSource).toContain("llmFetch: deps.llmFetch,");
    expect(providerSource).toContain("createLoopProvider,");
  });

  it("keeps routine and interactive loops on the shared guarded fetch path", async () => {
    const bootSource = await readBootWiring();

    expect(bootSource).toMatch(/const routineLoopDeps = \{[\s\S]*?llmFetch,/);
    expect(bootSource).toMatch(/createConversationLoop\(\{[\s\S]*?llmFetch,/);
    expect(bootSource).toMatch(/parentDeps: \{[\s\S]*?llmFetch,/);
  });

  it("keeps builtin web_fetch on the injected Electron network fetch", async () => {
    const bootToolsSource = await readSource("../boot/tools.ts");
    const webFetchSource = await readSource("../tools/web-fetch.ts");

    // Boot injects the Electron network-stack fetch into the tool factory…
    expect(bootToolsSource).toContain("createWebFetchTool(networkFetch)");
    // …and the tool threads it straight into the SSRF guard rather than the
    // global fetch, so host-resolver-rules stay honored.
    expect(webFetchSource).toContain(
      "export function createWebFetchTool(networkFetch: typeof fetch)",
    );
    expect(webFetchSource).toContain("fetchImpl: networkFetch,");
  });
});
