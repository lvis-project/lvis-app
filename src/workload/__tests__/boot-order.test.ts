import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("workload broker boot ordering", () => {
  it("verifies the native headless binding before host and tool construction", () => {
    const text = readFileSync(resolve(process.cwd(), "src/headless-host.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const initialize = text.indexOf("await initializeWorkloadBroker(request.workloadBroker)");
    const binding = text.indexOf("isActiveWorkloadBrokerCwd(request.turn.cwd)", initialize);
    const host = text.indexOf("const createHost = () => createNodeBootHost({", binding);
    const tools = text.indexOf("createWindowlessHost(projectRoot, host)", host);
    expect(initialize).toBeGreaterThan(-1);
    expect(binding).toBeGreaterThan(initialize);
    expect(host).toBeGreaterThan(binding);
    expect(tools).toBeGreaterThan(host);
  });

  it("verifies the Electron headless binding before desktop startup", () => {
    const text = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8")
      .replace(/\r\n/g, "\n");
    const initialize = text.indexOf("await initializeWorkloadBroker(execRequest.workloadBroker)");
    const binding = text.indexOf("isActiveWorkloadBrokerCwd(execRequest.turn.cwd)", initialize);
    const startDesktop = text.indexOf("const startDesktop = async () =>", binding);
    const bootstrap = text.indexOf("bootstrap(projectRoot", startDesktop);
    expect(initialize).toBeGreaterThan(-1);
    expect(binding).toBeGreaterThan(initialize);
    expect(startDesktop).toBeGreaterThan(binding);
    expect(bootstrap).toBeGreaterThan(startDesktop);
  });
});
