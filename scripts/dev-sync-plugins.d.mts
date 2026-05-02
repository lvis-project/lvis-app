export function isSafePluginId(id: unknown): boolean;
export function buildCopyFilter(sourceRoot: string): (src: string) => boolean;
export function removeAny(target: string): void;
export function neutralizeLegacyInstallDirSymlink(installDir: string): boolean;
export function syncDevPlugins(): Array<{
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "dev";
  approvedPluginAccess?: unknown;
}>;
export function countEntries(dir: string): number;
