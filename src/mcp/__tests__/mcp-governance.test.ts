import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGovernance } from "../mcp-governance.js";
import type { McpGovernancePolicy } from "../types.js";

const testDir = join(tmpdir(), `lvis-mcp-governance-${process.pid}`);
const policyPath = join(testDir, "mcp-policy.json");

async function writePolicy(policy: McpGovernancePolicy): Promise<void> {
  if (!existsSync(testDir)) {
    await mkdir(testDir, { recursive: true });
  }
  await writeFile(policyPath, JSON.stringify(policy, null, 2), "utf-8");
}

function makePolicy(status: "approved" | "revoked"): McpGovernancePolicy {
  return {
    version: "1.0",
    defaultPolicy: "deny",
    servers: [
      {
        id: "srv-a",
        status,
        allowedTransports: ["stdio"],
        allowedOrigins: [],
        maxTools: 5,
        maxConcurrentRequests: 2,
        toolPermissionMode: "default",
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      auditLevel: "full",
      killSwitchEnabled: true,
      policyRefreshIntervalMs: 20,
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  await rm(testDir, { recursive: true, force: true });
});

describe("McpGovernance.startPolicyRefresh", () => {
  it("notifies newly revoked servers once per transition", async () => {
    vi.useFakeTimers();
    await writePolicy(makePolicy("approved"));
    const governance = new McpGovernance(policyPath);
    const onRevoked = vi.fn();

    governance.startPolicyRefresh(onRevoked);

    await writePolicy(makePolicy("revoked"));
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(25);

    expect(onRevoked).toHaveBeenCalledOnce();
    expect(onRevoked).toHaveBeenCalledWith(["srv-a"]);

    governance.stopPolicyRefresh();
  });
});
