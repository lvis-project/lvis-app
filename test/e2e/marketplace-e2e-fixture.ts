import AdmZip from "adm-zip";
import type { MarketplaceHttp } from "../../src/plugins/marketplace-installer.js";
import type { SignatureEnvelope } from "../../src/plugins/types.js";

/** Minimal signed-plugin fixture shared by the live install and containment tests. */
export function buildPluginZip(slug: string, version: string): Buffer {
  const zip = new AdmZip();
  const pluginJson = {
    id: slug,
    name: "Marketplace E2E Plugin",
    version,
    entry: "index.js",
    installPolicy: "user",
    description: "Marketplace loopback e2e test plugin",
    publisher: "lvis-community",
    tools: [],
  };
  zip.addFile("plugin.json", Buffer.from(JSON.stringify(pluginJson)));
  zip.addFile("index.js", Buffer.from("module.exports = { smoke: () => 'ok' };\n"));
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
): Promise<void> {
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
}
