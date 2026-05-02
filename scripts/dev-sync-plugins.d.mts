export function isSafePluginId(id: unknown): boolean;
export function buildCopyFilter(sourceRoot: string): (src: string) => boolean;
export function removeAny(target: string): void;
export function neutralizeLegacyInstallDirSymlink(installDir: string): boolean;
export function isDevRegistryEntry(entry: {
  installSource?: "admin" | "user" | "local-dev" | "dev" | "dev-link";
  _devLinked?: boolean;
} | null | undefined): boolean;
export function normalizePreservedNonDevRegistryEntry<T extends {
  _devLinked?: boolean;
}>(entry: T): Omit<T, "_devLinked"> | null;
export function loadExistingNonDevPlugins(): Array<Record<string, unknown>>;
export function buildDevRegistryEntry(pluginId: string, manifest: {
  pluginAccess?: unknown;
}): {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "dev";
  approvedPluginAccess?: unknown;
};
export function copyFileAsRealFile(src: string, dest: string): void;
export function syncDevPlugins(): Array<{
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "dev";
  approvedPluginAccess?: unknown;
}>;
export function countEntries(dir: string): number;
