import type { Session } from "electron";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PLUGIN_ASSET_SCHEME = "lvis-plugin";
const PLUGIN_ASSET_HOST = "asset";

const rootsByPartition = new Map<string, PartitionAssetRoot>();
const handledPartitions = new Set<string>();

export function registerPluginAssetProtocolScheme(
  protocolApi: Pick<Electron.Protocol, "registerSchemesAsPrivileged">,
): void {
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

export function pluginAssetUrlFromRealPath(realRoot: string, realAsset: string): string {
  const relativePath = path.relative(realRoot, realAsset);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("plugin asset path must be inside plugin root");
  }
  const encoded = relativePath
    .split(path.sep)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${PLUGIN_ASSET_SCHEME}://${PLUGIN_ASSET_HOST}/${encoded}`;
}

export async function resolvePluginAssetRequest(
  pluginRoot: string,
  requestUrl: string,
  options: { rootIsReal?: boolean } = {},
): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${PLUGIN_ASSET_SCHEME}:` || url.hostname !== PLUGIN_ASSET_HOST) {
    return null;
  }

  let relPath: string;
  try {
    relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return null;
  }
  if (!relPath || relPath.includes("\0") || relPath.includes("\\")) {
    return null;
  }

  let realRoot: string;
  let realAsset: string;
  try {
    realRoot = options.rootIsReal ? pluginRoot : await realpath(pluginRoot);
    realAsset = await realpath(path.resolve(realRoot, relPath));
  } catch {
    return null;
  }
  const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realAsset !== realRoot && !realAsset.startsWith(rootWithSep)) {
    return null;
  }
  return realAsset;
}

type PartitionAssetRoot = {
  pluginRoot: string;
  realRoot?: string;
};

export function installPluginAssetProtocolHandler(
  partitionName: string,
  ses: Session,
  pluginRoot: string,
): void {
  const previous = rootsByPartition.get(partitionName);
  rootsByPartition.set(
    partitionName,
    previous?.pluginRoot === pluginRoot ? previous : { pluginRoot },
  );
  if (handledPartitions.has(partitionName)) return;
  handledPartitions.add(partitionName);

  ses.protocol.handle(PLUGIN_ASSET_SCHEME, async (request) => {
    const rootRecord = rootsByPartition.get(partitionName);
    if (!rootRecord) return new Response("plugin asset root missing", { status: 404 });
    let realRoot = rootRecord.realRoot;
    if (!realRoot) {
      try {
        realRoot = await realpath(rootRecord.pluginRoot);
        rootRecord.realRoot = realRoot;
      } catch {
        return new Response("plugin asset root missing", { status: 404 });
      }
    }
    const assetPath = await resolvePluginAssetRequest(realRoot, request.url, {
      rootIsReal: true,
    });
    if (!assetPath) return new Response("plugin asset denied", { status: 403 });
    const { net } = await import("electron");
    return net.fetch(pathToFileURL(assetPath).toString());
  });
}
