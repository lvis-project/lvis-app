import AdmZip from "adm-zip";
import type { MarketplaceHttp } from "../../src/plugins/marketplace-installer.js";
import type { SignatureEnvelope } from "../../src/plugins/types.js";

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
        properties: { operation: { type: "string", enum: ["get_version"] } },
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
          },
        },
      },
    }],
    ...(options.bundledContributions
      ? {
          skills: [{ id: "lifecycle", path: "skills/lifecycle" }],
          hooks: [{ id: "audit", path: "hooks/audit.json" }],
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
      "",
    ].join("\n")));
    zip.addFile("hooks/audit.json", Buffer.from(JSON.stringify({ hooks: { PreToolUse: [] } })));
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
  const form = new FormData();
  form.append(
    "file",
    new Blob([zipBytes], { type: "application/zip" }),
    `${slug}-${version}.zip`,
  );
  const res = await fetch(`${baseUrl}/api/v1/plugins/${slug}/versions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
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
  const headers = { Authorization: `Bearer ${adminKey}` };
  const pending = await fetch(`${baseUrl}/api/v1/admin/publishes/pending`, { headers });
  if (!pending.ok) throw new Error(`pending publishes returned ${pending.status}`);
  const rows = await pending.json() as Array<{ id?: unknown; slug?: unknown; version?: unknown }>;
  const row = rows.find((item) => item.slug === slug && item.version === version);
  if (!row || (typeof row.id !== "number" && typeof row.id !== "string")) {
    throw new Error(`pending publish not found: ${slug}@${version}`);
  }
  const approved = await fetch(`${baseUrl}/api/v1/admin/publishes/${row.id}/approve`, {
    method: "POST",
    headers,
  });
  if (!approved.ok) {
    throw new Error(`approve failed: status=${approved.status} body=${await approved.text()}`);
  }
  return await approved.json() as Record<string, unknown>;
}
