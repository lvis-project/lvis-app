// Type declarations for scripts/uv-targets.mjs.
// Hand-written because source scripts consume the module before TS compile.

export interface UvTarget {
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly bin: "uv" | "uv.exe";
  readonly archive: string;
  readonly archiveSha256: string;
  readonly type: "tar.gz" | "zip";
}

export interface InstallerUvTarget extends UvTarget {
  readonly archFlag: "--arm64" | "--x64";
}

export const UV_TARGETS: readonly UvTarget[];
export const UV_TARGET_BY_DIR: ReadonlyMap<string, UvTarget>;
export const SUPPORTED_UV_TARGET_DIRS: readonly string[];

export function getUvTargetByDir(dir: string): UvTarget;
export function resolveUvTarget(platform: string, arch: string): UvTarget;
export function installerUvTargetFor(
  installerTarget: string,
  platform?: string,
  arch?: string,
): InstallerUvTarget;
