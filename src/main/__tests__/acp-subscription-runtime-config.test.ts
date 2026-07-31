import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACP_SUBSCRIPTION_RUNTIME_POLICY_VERSION,
  GROK_BUILD_GOVERNED_AGENT_PROFILE,
  GROK_BUILD_REQUIRED_MINIMUM_VERSION,
  acpSubscriptionNativePolicyFiles,
  acpSubscriptionRuntimeDirectoryNames,
  ensureAcpSubscriptionNativePolicy,
  validateAcpSubscriptionMcpServerConfigs,
} from "../acp-subscription-runtime-config.js";

const runtimeRoots: string[] = [];

function createRuntimeHome(name: string): string {
  const root = mkdtempSync(join(tmpdir(), "lvis-acp-policy-"));
  runtimeRoots.push(root);
  const runtimeHome = join(root, name);
  mkdirSync(runtimeHome, { recursive: true });
  return runtimeHome;
}

afterEach(() => {
  for (const root of runtimeRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ACP subscription native policies", () => {
  it("materializes the exact versioned Kimi policy and rejects any appended runtime config", async () => {
    const runtimeHome = createRuntimeHome("acp-v8-kimi-code-home");
    const files = acpSubscriptionNativePolicyFiles("kimi-code", runtimeHome);

    await ensureAcpSubscriptionNativePolicy("kimi-code", runtimeHome);

    const config = readFileSync(files.configToml as string, "utf8");
    const tui = readFileSync(files.tuiToml as string, "utf8");
    expect(config).toContain(`# lvis-acp-native-policy-v${ACP_SUBSCRIPTION_RUNTIME_POLICY_VERSION}`);
    expect(config).toContain('default_permission_mode = "manual"');
    expect(config).toContain('enabled = ["mcp__lvis-host-tools__*"]');
    expect(config).toContain('pattern = "mcp__lvis-host-tools__*"');
    expect(config).toContain("max_steps_per_turn = 1");
    expect(tui).toContain(`[upgrade]\nauto_install = false`);

    const appended = `${config}\n[oauth]\nissuer = "runtime-owned"\n`;
    writeFileSync(files.configToml as string, appended, "utf8");
    await expect(ensureAcpSubscriptionNativePolicy("kimi-code", runtimeHome)).rejects.toMatchObject({
      code: "acp-runtime-policy-unverified",
    });
    expect(readFileSync(files.configToml as string, "utf8")).toBe(appended);
  });

  it("pins the exact Grok bridge-only policy in each config precedence path and fails closed on tampering", async () => {
    const runtimeHome = createRuntimeHome("acp-v8-grok-build-home");
    const files = acpSubscriptionNativePolicyFiles("grok-build", runtimeHome);
    await ensureAcpSubscriptionNativePolicy("grok-build", runtimeHome);
    const requirementsPath = files.requirementsToml as string;
    const configPath = files.configToml as string;
    const agentProfilePath = files.agentProfileMd as string;
    const requirements = readFileSync(requirementsPath, "utf8");
    const config = readFileSync(configPath, "utf8");
    const agentProfile = readFileSync(agentProfilePath, "utf8");
    expect(requirements).not.toBe(config);
    expect(config).toContain(`[cli]\nauto_update = false\nrequired_minimum_version = "${GROK_BUILD_REQUIRED_MINIMUM_VERSION}"`);
    expect(requirements).toContain(`[cli]\nauto_update = false\nrequired_minimum_version = "${GROK_BUILD_REQUIRED_MINIMUM_VERSION}"`);
    expect(agentProfile).toContain(`name: ${GROK_BUILD_GOVERNED_AGENT_PROFILE.name}`);
    expect(agentProfile).toContain("injectDefaultTools: false");
    expect(agentProfile).toContain("mcpInheritance: none");
    expect(agentProfile).toContain("mcp__lvis-host-tools__workspace_read");
    expect(config).toContain('  { action = "deny", tool = "bash" },');
    expect(config).toContain('  { action = "deny", tool = "webfetch" },');
    expect(config).toContain('  { action = "allow", tool = "mcp", pattern = "lvis-host-tools__*" },');
    expect(config).toContain("[[hooks.PreToolUse]]");
    expect(config).toContain("subscription-grok-tool-policy-hook.js");
    expect(config).toContain('ELECTRON_RUN_AS_NODE = "1"');
    expect(config).toContain("timeout = 10");
    expect(config).toContain("[features]\nmanaged_config = false");
    expect(config).toContain("[compat.claude]\nskills = false");
    expect(config).toContain("[claude_compat]\nimported = true");
    expect(config).toContain("[managed_mcps]\nenabled = false\ngateway_tools_enabled = false");
    expect(config).not.toContain('tool = "websearch"');
    expect(requirements).toContain("[managed_mcps]\nenabled = false\n\n[subagents]");
    expect(requirements).toContain("[subagents]\nenabled = false");
    expect(requirements).toContain("[ui]\nyolo = false");
    expect(requirements).toContain("[features]\nweb_fetch = false");
    expect(requirements).not.toContain("tool_search = false");
    expect(requirements).not.toContain("gateway_tools_enabled");
    expect(requirements).not.toContain("[[hooks.PreToolUse]]");
    const corruptedConfig = config
      .replace('  { action = "deny", tool = "webfetch" },\n', "");
    writeFileSync(configPath, corruptedConfig, "utf8");

    await expect(ensureAcpSubscriptionNativePolicy("grok-build", runtimeHome)).rejects.toMatchObject({
      code: "acp-runtime-policy-unverified",
    });
    expect(readFileSync(configPath, "utf8")).toBe(corruptedConfig);

    const corruptedRequirements = requirements.replace("[managed_mcps]\nenabled = false\n", "[managed_mcps]\n");
    writeFileSync(configPath, config, "utf8");
    writeFileSync(requirementsPath, corruptedRequirements, "utf8");
    await expect(ensureAcpSubscriptionNativePolicy("grok-build", runtimeHome)).rejects.toMatchObject({
      code: "acp-runtime-policy-unverified",
    });
    expect(readFileSync(requirementsPath, "utf8")).toBe(corruptedRequirements);
    const corruptedAgentProfile = agentProfile.replace("injectDefaultTools: false\n", "");
    writeFileSync(requirementsPath, requirements, "utf8");
    writeFileSync(agentProfilePath, corruptedAgentProfile, "utf8");
    await expect(ensureAcpSubscriptionNativePolicy("grok-build", runtimeHome)).rejects.toMatchObject({
      code: "acp-runtime-policy-unverified",
    });
    expect(readFileSync(agentProfilePath, "utf8")).toBe(corruptedAgentProfile);
  });

  it("fails closed when Kimi global policy values are moved below a TOML table", async () => {
    const runtimeHome = createRuntimeHome("acp-v8-kimi-code-home");
    const files = acpSubscriptionNativePolicyFiles("kimi-code", runtimeHome);
    await ensureAcpSubscriptionNativePolicy("kimi-code", runtimeHome);
    const config = readFileSync(files.configToml as string, "utf8");
    const globalPolicy = [
      'default_permission_mode = "manual"',
      "default_plan_mode = false",
      "merge_all_available_skills = false",
      "telemetry = false",
    ].join("\n");
    const malformed = `${config.replace(`${globalPolicy}\n\n`, "")}\n${globalPolicy}\n`;
    writeFileSync(files.configToml as string, malformed, "utf8");

    await expect(ensureAcpSubscriptionNativePolicy("kimi-code", runtimeHome)).rejects.toMatchObject({
      code: "acp-runtime-policy-unverified",
    });
    expect(readFileSync(files.configToml as string, "utf8")).toBe(malformed);
  });

  it("accepts only one narrow host-created stdio MCP descriptor", () => {
    const trusted = {
      name: "lvis-subscription-tools",
      command: process.execPath,
      args: ["--lvis-acp-mcp", "--stdio"],
      env: { ELECTRON_RUN_AS_NODE: "1", LVIS_ACP_SESSION: "host-created" },
    };

    expect(validateAcpSubscriptionMcpServerConfigs([])).toEqual([]);
    expect(validateAcpSubscriptionMcpServerConfigs([trusted])).toEqual([trusted]);
    expect(() => validateAcpSubscriptionMcpServerConfigs([
      { ...trusted, cwd: "C:\\untrusted" },
    ])).toThrow("invalid-acp-subscription-mcp-server-config");
    expect(() => validateAcpSubscriptionMcpServerConfigs([
      { ...trusted, command: "node" },
    ])).toThrow("invalid-acp-subscription-mcp-server-config");
    expect(() => validateAcpSubscriptionMcpServerConfigs([
      { ...trusted, env: { constructor: "blocked" } },
    ])).toThrow("invalid-acp-subscription-mcp-server-config");
    expect(() => validateAcpSubscriptionMcpServerConfigs([trusted, trusted]))
      .toThrow("invalid-acp-subscription-mcp-server-config");
  });

  it("derives static v8 homes for each allowlisted provider", () => {
    expect(acpSubscriptionRuntimeDirectoryNames("kimi-code")).toEqual({
      runtimeHome: "acp-v8-kimi-code-home",
      workspaceDir: "acp-v8-kimi-code-workspace",
      runtimeTempDir: "acp-v8-kimi-code-tmp",
    });
    expect(acpSubscriptionRuntimeDirectoryNames("grok-build").runtimeHome).toBe("acp-v8-grok-build-home");
  });
});
