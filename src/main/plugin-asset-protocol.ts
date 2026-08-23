import type { Session } from "electron";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPathWithin } from "../plugins/plugin-storage-containment.js";

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

  let resolvedRoot: string;
  let resolvedAsset: string;
  try {
    resolvedRoot = options.rootIsReal ? pluginRoot : await realpath(pluginRoot);
    resolvedAsset = await realpath(path.resolve(resolvedRoot, relPath));
  } catch {
    return null;
  }
  if (!isPathWithin(resolvedRoot, resolvedAsset)) {
    return null;
  }
  return resolvedAsset;
}

type PartitionAssetRoot = {
  pluginRoot: string;
  realRoot?: string;
};

/**
 * Serve `lvis-plugin://asset/...` for one plugin partition, and point it at the
 * plugin's install root.
 *
 * The two halves are deliberately separable. Registering the scheme on the
 * session is what a renderer frame in that partition needs BEFORE it starts
 * loading: a frame is handed its set of URL loaders once, when it begins
 * loading, and a scheme registered afterwards is not in that set — every
 * request the frame makes for it fails with `ERR_UNKNOWN_URL_SCHEME` without
 * ever reaching the handler below, and it keeps failing for the life of the
 * frame. No retry can recover it, because the frame is asking a loader table
 * that has no entry for the scheme.
 *
 * The root, by contrast, is not known that early for every plugin. A
 * worker-backed plugin's root is a per-generation payload directory that only
 * exists once its runtime has been provisioned, so boot installs the partition
 * policy with no root and calls back with one later. Registering the scheme
 * only once a root was available is what put the plugin shell on the wrong side
 * of that race — its `<webview>` loaded first, its `import()` of the entry
 * module got `ERR_UNKNOWN_URL_SCHEME`, and the panel stayed on "Plugin UI
 * failed to load" until the app restarted. So the handler goes on as soon as
 * the partition exists and answers 404 until a root is set.
 *
 * @param pluginRoot the plugin's install root, or undefined when it is not
 *   resolved yet. A later call with a root sets it; a call without one never
 *   clears a root already recorded.
 */
export function installPluginAssetProtocolHandler(
  partitionName: string,
  ses: Session,
  pluginRoot?: string,
): void {
  if (pluginRoot) {
    const previous = rootsByPartition.get(partitionName);
    rootsByPartition.set(
      partitionName,
      previous?.pluginRoot === pluginRoot ? previous : { pluginRoot },
    );
  }
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
