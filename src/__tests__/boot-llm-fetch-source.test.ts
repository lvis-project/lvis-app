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
    // The turn provider factory moved out of conversation-loop.ts into
    // engine/turn/provider.ts (C9 decomposition); the azure-foundry fetch
    // scoping is preserved there as a free fn (`deps.llmFetch`, not `this.deps`).
    const providerSource = await readSource("../engine/turn/provider.ts");

    expect(bootSource).toContain(
      '...(llmVendor === "azure-foundry" ? { fetch: llmFetch } : {}),',
    );
    expect(providerSource).toContain('config.vendor === "azure-foundry" && deps.llmFetch');
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
