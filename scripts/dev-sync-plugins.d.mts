type PluginRegistryEntryInstallSource = "admin" | "user" | "local-dev" | "dev" | "dev-link";

type DevRegistryEntry = {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: "dev";
  approvedPluginAccess?: unknown;
};

export function isSafePluginId(id: unknown): boolean;
export function isSafeRelativeManifestEntry(entry: unknown): boolean;
export function isContainedPath(root: string, target: string): boolean;
export function resolveContainedManifestEntry(pluginRepoDir: string, entry: unknown): string | null;
export function buildCopyFilter(sourceRoot: string): (src: string) => boolean;
export function removeAny(target: string): void;
export function neutralizeLegacyInstallDirSymlink(installDir: string): boolean;
export function isDevRegistryEntry(entry: {
  installSource?: PluginRegistryEntryInstallSource;
  _devLinked?: boolean;
} | null | undefined): boolean;
export function normalizePreservedNonDevRegistryEntry<T extends {
  _devLinked?: boolean;
}>(entry: T): Omit<T, "_devLinked"> | null;
export function buildUpdatedRegistryDocument(
  existingRegistry: Record<string, unknown> | null | undefined,
  plugins: Array<Record<string, unknown>>,
): Record<string, unknown> & {
  version: number;
  plugins: Array<Record<string, unknown>>;
};
export function loadExistingRegistryState(): {
  registryDocument: Record<string, unknown>;
  existingPlugins: Array<Record<string, unknown>>;
};
export function buildDevRegistryEntry(pluginId: string, manifest: {
  pluginAccess?: unknown;
}): DevRegistryEntry;
export function copyFileAsRealFile(src: string, dest: string): void;
export function copyManifestEntryFromContainedSource(src: string, dest: string): void;
export function syncDevPlugins(): Array<DevRegistryEntry>;
export function countEntries(dir: string): number;
