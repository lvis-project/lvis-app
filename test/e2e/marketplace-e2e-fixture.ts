import AdmZip from "adm-zip";
import type { MarketplaceHttp } from "../../src/plugins/marketplace-installer.js";
import type { SignatureEnvelope } from "../../src/plugins/types.js";

export const EXACT_LOOPBACK_MARKETPLACE_ORIGIN = "http://127.0.0.1:8765";

/**
 * Mutating Marketplace E2E requests are destructive by design. Keep them
 * pinned to the one ephemeral server started by marketplace-e2e.yml.
 */
export function requireExactLoopbackMarketplaceOrigin(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Marketplace E2E refuses invalid target ${JSON.stringify(baseUrl)}`);
  }
  if (
    url.origin !== EXACT_LOOPBACK_MARKETPLACE_ORIGIN ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error(
      `Marketplace E2E refuses target ${url.origin}; expected exact loopback origin ` +
      EXACT_LOOPBACK_MARKETPLACE_ORIGIN,
    );
  }
  return EXACT_LOOPBACK_MARKETPLACE_ORIGIN;
}

export async function postMarketplace(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: Omit<RequestInit, "method"> = {},
): Promise<Response> {
  const origin = requireExactLoopbackMarketplaceOrigin(baseUrl);
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(`Marketplace E2E refuses non-root-relative POST path ${JSON.stringify(path)}`);
  }
  const endpoint = new URL(path, `${origin}/`);
  if (endpoint.origin !== origin) {
    throw new Error(`Marketplace E2E refuses cross-origin POST target ${endpoint.origin}`);
  }
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  return fetch(endpoint, {
    ...init,
    method: "POST",
    headers,
  });
}

/** Deterministic plugin bundle used by the installer and live Electron lanes. */
export function buildPluginZip(
  slug: string,
  version: string,
  options: { installPolicy?: "user" | "admin"; bundledContributions?: boolean } = {},
): Buffer {
  const zip = new AdmZip();
  const toolName = `${slug.replace(/-/g, "_")}_read`;
  const pluginJson = {
    id: slug,
    name: "Marketplace E2E Plugin",
    version,
    entry: "index.js",
    installPolicy: options.installPolicy ?? "user",
    description: "Marketplace loopback e2e test plugin",
    publisher: "lvis-community",
    requires: { minAppVersion: "0.5.2" },
    tools: [{
      name: toolName,
      description: "Read the active marketplace E2E generation.",
      inputSchema: {
        type: "object",
        properties: { operation: { type: "string", enum: ["get_version", "hook_probe"] } },
        required: ["operation"],
        additionalProperties: false,
      },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "lvisai/operationPolicy": {
          discriminant: "operation",
          operations: {
            get_version: {
              kind: "read",
              minimumRisk: "read",
              appVisible: true,
            },
            hook_probe: {
              kind: "read",
              minimumRisk: "read",
              appVisible: true,
            },
          },
        },
      },
    }],
    ...(options.bundledContributions
      ? {
          skills: [{ id: "lifecycle", path: "skills/lifecycle" }],
          hooks: [{ id: "audit", path: "hooks/audit.json" }],
          mcpServers: [{ id: "echo", path: "mcp/echo.json" }],
        }
      : {}),
  };
  zip.addFile("plugin.json", Buffer.from(JSON.stringify(pluginJson)));
  zip.addFile("index.js", Buffer.from(
    `export default async function createPlugin() {\n` +
    `  return { handlers: { ${toolName}: async () => ({ version: ${JSON.stringify(version)} }) } };\n` +
    `}\n`,
  ));
  if (options.bundledContributions) {
    zip.addFile("skills/lifecycle/SKILL.md", Buffer.from([
      "---",
      `name: ${slug}-lifecycle`,
      "description: Use for the deterministic marketplace lifecycle fixture.",
      "---",
      "Call the fixture read tool and report the returned generation version.",
      `fixture-version:${version}`,
      "",
    ].join("\n")));
    zip.addFile("hooks/audit.json", Buffer.from(JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: toolName,
          hooks: [{
            type: "command",
            command: ["node", "./deny-probe.mjs"],
            timeoutMs: 5_000,
          }],
        }],
      },
    })));
    zip.addFile("hooks/deny-probe.mjs", Buffer.from(
      `process.stdin.resume();\n` +
      `process.stdin.on("end", () => process.stdout.write(JSON.stringify({ action: "deny", reason: "marketplace lifecycle hook probe" })));\n`,
    ));
    zip.addFile("mcp/echo.json", Buffer.from(JSON.stringify({
      transport: "stdio",
      command: "node",
      args: ["./echo-server.mjs"],
      auth: "none",
    })));
    zip.addFile("mcp/echo-server.mjs", Buffer.from([
      "let buffer = Buffer.alloc(0);",
      `const fixtureVersion = ${JSON.stringify(version)};`,
      "const processIdentity = `${process.pid}:${Date.now()}:${process.hrtime.bigint().toString()}`;",
      "function write(message) {",
      "  const json = JSON.stringify(message);",
      "  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, \"utf8\")}\\r\\n\\r\\n${json}`);",
      "}",
      "function handle(req) {",
      "  if (req.method === \"server/discover\") return { jsonrpc: \"2.0\", id: req.id, result: { resultType: \"complete\", supportedVersions: [\"2026-07-28\"], serverInfo: { name: \"bundle-echo\", version: fixtureVersion }, capabilities: { tools: { listChanged: false } } } };",
      "  if (req.method === \"tools/list\") return { jsonrpc: \"2.0\", id: req.id, result: { resultType: \"complete\", tools: [{ name: \"bundle_echo\", description: \"Echo a deterministic bundle probe.\", inputSchema: { type: \"object\", properties: { text: { type: \"string\" } }, required: [\"text\"], additionalProperties: false } }] } };",
      "  if (req.method === \"tools/call\") return { jsonrpc: \"2.0\", id: req.id, result: { resultType: \"complete\", content: [{ type: \"text\", text: JSON.stringify({ echo: String(req.params?.arguments?.text ?? \"\"), version: fixtureVersion, pid: process.pid, processIdentity }) }] } };",
      "  return { jsonrpc: \"2.0\", id: req.id, error: { code: -32601, message: \"Method not found\" } };",
      "}",
      "process.stdin.on(\"data\", (chunk) => {",
      "  buffer = Buffer.concat([buffer, chunk]);",
      "  for (;;) {",
      "    const headerEnd = buffer.indexOf(\"\\r\\n\\r\\n\");",
      "    if (headerEnd < 0) break;",
      "    const match = buffer.subarray(0, headerEnd).toString(\"ascii\").match(/Content-Length:\\s*(\\d+)/i);",
      "    if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }",
      "    const length = Number(match[1]);",
      "    const start = headerEnd + 4;",
      "    if (buffer.length < start + length) break;",
      "    const request = JSON.parse(buffer.subarray(start, start + length).toString(\"utf8\"));",
      "    buffer = buffer.subarray(start + length);",
      "    if (request.method && request.id !== undefined) write(handle(request));",
      "  }",
      "});",
      "",
    ].join("\n")));
  }
  return zip.toBuffer();
}

export function makeLiveHttp(baseUrl: string): MarketplaceHttp {
  return {
    async downloadArtifact(slug, version) {
      const url = `${baseUrl}/api/v1/plugins/${slug}/versions/${version}/download`;
      const res = await fetch(url);
      const body = Buffer.from(await res.arrayBuffer());
      return {
        body,
        sha256Header: res.headers.get("X-Plugin-SHA256"),
        status: res.status,
        retryAfterSeconds: res.headers.get("Retry-After")
          ? Number(res.headers.get("Retry-After")) || undefined
          : undefined,
      };
    },
    async fetchSignatureEnvelope(slug, version) {
      const url = `${baseUrl}/api/v1/plugins/${slug}/versions/${version}/download.sig`;
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`download.sig returned ${res.status}`);
      }
      return (await res.json()) as SignatureEnvelope;
    },
  };
}

export async function publishPlugin(
  baseUrl: string,
  apiKey: string,
  slug: string,
  version: string,
  zipBytes: Buffer,
): Promise<Record<string, unknown>> {
  requireExactLoopbackMarketplaceOrigin(baseUrl);
  const form = new FormData();
  form.append(
    "file",
    new Blob([zipBytes], { type: "application/zip" }),
    `${slug}-${version}.zip`,
  );
  const res = await postMarketplace(baseUrl, apiKey, `/api/v1/plugins/${slug}/versions`, {
    body: form,
  });
  if (res.status !== 201) {
    const detail = await res.text();
    throw new Error(`publish failed: status=${res.status} body=${detail}`);
  }
  return await res.json() as Record<string, unknown>;
}

export async function approvePendingPlugin(
  baseUrl: string,
  adminKey: string,
  slug: string,
  version: string,
): Promise<Record<string, unknown>> {
  const origin = requireExactLoopbackMarketplaceOrigin(baseUrl);
  const headers = { Authorization: `Bearer ${adminKey}` };
  const pending = await fetch(`${origin}/api/v1/admin/publishes/pending`, { headers });
  if (!pending.ok) throw new Error(`pending publishes returned ${pending.status}`);
  const rows = await pending.json() as Array<{ id?: unknown; slug?: unknown; version?: unknown }>;
  const row = rows.find((item) => item.slug === slug && item.version === version);
  if (!row || (typeof row.id !== "number" && typeof row.id !== "string")) {
    throw new Error(`pending publish not found: ${slug}@${version}`);
  }
  const approved = await postMarketplace(
    origin,
    adminKey,
    `/api/v1/admin/publishes/${row.id}/approve`,
  );
  if (!approved.ok) {
    throw new Error(`approve failed: status=${approved.status} body=${await approved.text()}`);
  }
  return await approved.json() as Record<string, unknown>;
}
