import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { McpGovernance } from "../mcp-governance.js";
import type { McpGovernancePolicy } from "../types.js";

/**
 * Build a governance instance whose internal policy is swapped out to the
 * in-memory one we provide. Avoids needing a real policy FILE on disk —
 * `McpGovernance` still probes the path (existsSync/readFileSync) but falls
 * back to the default policy when it is missing (see below).
 *
 * Constructing with a path that does not exist → default policy is loaded;
 * then we override via the untyped `policy` field. This mirrors how the
 * governance layer behaves when IT Admin updates the file in place.
 */
export function governanceWithPolicy(policy: McpGovernancePolicy): McpGovernance {
  const gov = new McpGovernance("/nonexistent/mcp-policy.json");
  (gov as unknown as { policy: McpGovernancePolicy }).policy = policy;
  return gov;
}

/** Build an `approved` stdio server governance approval for the given command. */
export function stdioApproval(
  id: string,
  command: string,
  overrides: Partial<McpGovernancePolicy["servers"][number]> = {},
): McpGovernancePolicy["servers"][number] {
  return {
    id,
    name: id,
    status: "approved",
    transport: "stdio",
    allowedCommands: [command],
    requiredAuth: "none",
    tlsRequired: false,
    allowedCapabilities: ["tools"],
    maxTools: 16,
    toolNamePrefix: id,
    toolPermissionMode: "default",
    connectionTimeoutMs: 5_000,
    maxConcurrentRequests: 4,
    ...overrides,
  };
}

/** Wrap a list of server approvals in a deny-by-default governance policy. */
export function buildPolicy(
  approvals: McpGovernancePolicy["servers"],
): McpGovernancePolicy {
  return {
    version: "1.0-test",
    defaultPolicy: "deny",
    servers: approvals,
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      policyRefreshIntervalMs: 60_000,
    },
  };
}

/**
 * A Content-Length framed JSON-RPC stdio child stub. Walks `stdinBuffer`,
 * extracts every complete frame, and writes a framed response back on stdout
 * using the matching builder from `responses`. Notifications (no id) get no
 * reply. Shared between the stdio transport regression + sandbox-wrap tests.
 */
export class FakeChildProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = {
    writable: true,
    write: (chunk: string) => {
      this.stdinBuffer += chunk;
      this.parseAndRespond();
      return true;
    },
    end: () => {
      this.stdin.writable = false;
    },
  };
  exitCode: number | null = null;
  private stdinBuffer = "";

  /** Prepared responses keyed by method name. */
  responses: Record<string, (id: number) => unknown> = {};

  kill(_signal?: string): boolean {
    this.exitCode = 0;
    this.emit("exit", 0, null);
    return true;
  }

  private parseAndRespond(): void {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerEnd = this.stdinBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.stdinBuffer.slice(0, headerEnd);
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) {
        this.stdinBuffer = this.stdinBuffer.slice(headerEnd + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = headerEnd + 4;
      if (this.stdinBuffer.length < bodyStart + len) return;
      const body = this.stdinBuffer.slice(bodyStart, bodyStart + len);
      this.stdinBuffer = this.stdinBuffer.slice(bodyStart + len);
      try {
        const req = JSON.parse(body) as { method: string; id?: number };
        // Notifications have no id → do not reply.
        if (req.id === undefined) continue;
        const builder = this.responses[req.method];
        if (!builder) continue;
        const result = builder(req.id);
        const payload = JSON.stringify({ jsonrpc: "2.0", id: req.id, result });
        const frame = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;
        // Defer slightly so the client's Promise has time to register.
        queueMicrotask(() => this.stdout.write(frame));
      } catch {
        /* ignore malformed */
      }
    }
  }
}
