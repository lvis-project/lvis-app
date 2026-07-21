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
    expect(bootSource).toContain("demoFoundryHostMapFingerprint,");
    expect(bootSource).toContain("getAppliedDemoHostResolverFingerprint,");
    expect(bootSource).toContain("const electronNetFetch = net.fetch.bind(net);");
    expect(bootSource).toContain('session.fromPartition("lvis-private-endpoint-fetch")');
    expect(bootSource).toContain('await privateEndpointSession.setProxy({ mode: "direct" });');
    expect(bootSource).toContain("const llmFetch = createSafeLlmFetch(electronNetFetch, {");
    expect(bootSource).toContain("fetch: electronDirectFetch,");
    expect(bootSource).toContain("isMappedUrl: isDemoPrivateEndpointUrl,");
    expect(bootSource).toContain("appliedDemoHostMapFingerprint === getAppliedDemoHostResolverFingerprint()");
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

  it("routes builtin mapped web_fetch URLs through the direct private endpoint session", async () => {
    const bootSource = await readBootWiring();
    const toolsSource = await readSource("../boot/tools.ts");

    expect(bootSource).toMatch(/const privateNetworkFetch = createElectronFetch\(electronDirectFetch\);/);
    expect(bootSource).toMatch(/const workflowDeps: WorkflowToolDeps = \{[\s\S]*?privateNetworkFetch,/);
    expect(bootSource).toMatch(/const workflowDeps: WorkflowToolDeps = \{[\s\S]*?demoHostMapApplied: isAppliedDemoHostMap,/);
    expect(toolsSource).toContain("privateNetworkFetch?: typeof fetch;");
    expect(toolsSource).toContain("demoHostMapApplied?: boolean;");
    expect(toolsSource).toContain("webFetchFetchImpl(rawInput, workflowDeps, networkFetch)");
    expect(toolsSource).toContain("isDemoHostResolverMappedFetchInput(fetchInput, deps)");
  });
});
