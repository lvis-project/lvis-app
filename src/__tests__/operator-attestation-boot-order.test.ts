import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startAfterOperatorAttestation } from "../main/operator-attestation-boot.js";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

describe("operator attestation boot ordering", () => {
  it("does not run the boot callback when explicit verification fails", async () => {
    const start = vi.fn(async () => "started");
    const verify = vi.fn(async () => { throw new Error("invalid-attestation"); });
    await expect(startAfterOperatorAttestation("/run/lvis/attestation.json", start, verify))
      .rejects.toThrow("invalid-attestation");
    expect(verify).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves existing boot behavior when no attestation was requested", async () => {
    const start = vi.fn(async () => "started");
    const verify = vi.fn(async () => undefined);
    await expect(startAfterOperatorAttestation(undefined, start, verify))
      .resolves.toBe("started");
    expect(verify).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not treat an empty explicit path as an absent attestation", async () => {
    const start = vi.fn(async () => "started");
    const verify = vi.fn(async () => { throw new Error("empty-attestation-path"); });
    await expect(startAfterOperatorAttestation("", start, verify))
      .rejects.toThrow("empty-attestation-path");
    expect(verify).toHaveBeenCalledWith("");
    expect(start).not.toHaveBeenCalled();
  });

  it("wraps native host construction in the attestation gate", () => {
    const text = source("src/headless-host.ts");
    const gate = text.indexOf(".startAfterOperatorAttestation(attestationPath, createHost)");
    expect(gate).toBeGreaterThan(-1);
    expect(text.indexOf("const createHost = () => createNodeBootHost({")).toBeLessThan(gate);
    expect(text.indexOf("createWindowlessHost(projectRoot, host)", gate)).toBeGreaterThan(gate);
  });

  it("wraps Electron window and bootstrap construction in the attestation gate", () => {
    const text = source("src/main.ts");
    const gate = text.indexOf(
      ".startAfterOperatorAttestation(operatorAttestationPath, startDesktop)",
    );
    expect(gate).toBeGreaterThan(-1);
    expect(text.indexOf("createWindow({")).toBeLessThan(gate);
    expect(text.indexOf("loadMainStartupDependencies(")).toBeLessThan(gate);
    expect(text.indexOf("bootstrap(projectRoot", gate)).toBeGreaterThan(gate);
  });
});
