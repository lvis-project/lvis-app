import { createRequire } from "node:module";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildJavaToolOptions, getJavaProxyAgentJarPath } from "@anthropic-ai/sandbox-runtime/dist/sandbox/java-proxy-agent.js";
import { buildSandboxConfig, getVendoredJavaProxyAgentJarPath, rewriteAsarPathToUnpacked } from "../asrt-sandbox.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("JVM proxy agent resource", () => {
  it("configures the installed host-owned agent for external processes", () => {
    const expected = join(dirname(require.resolve("@anthropic-ai/sandbox-runtime/package.json")),
      "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
    const path = getVendoredJavaProxyAgentJarPath();
    expect(path).toBe(expected);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(lstatSync(path).size).toBeGreaterThan(0);
    expect(buildSandboxConfig({}).javaAgentJarPath).toBe(
      process.platform === "win32" ? undefined : path,
    );
    expect(getJavaProxyAgentJarPath(path)).toBe(path);
  });

  it("passes the physical archive sidecar path to the external JVM", () => {
    const root = mkdtempSync(join(tmpdir(), "jvm-agent-resource-"));
    roots.push(root);
    const virtual = join(root, "resources", "app.asar", "node_modules", "@anthropic-ai",
      "sandbox-runtime", "vendor", "java-proxy-agent", "srt-proxy-agent.jar");
    const physical = rewriteAsarPathToUnpacked(virtual);
    mkdirSync(dirname(physical), { recursive: true });
    cpSync(getVendoredJavaProxyAgentJarPath(), physical);
    const selected = getJavaProxyAgentJarPath(physical);
    expect(selected).toBe(physical);
    const options = buildJavaToolOptions({ agentJarPath: selected, inherited: "-Xmx128m" });
    expect(options).toContain(`-javaagent:${physical}`);
    expect(options).toContain("-Xmx128m");
    expect(options).not.toContain(virtual);
  });
});
