import type { PluginToolInvocationContext } from "../plugins/runtime/index.js";
import type { ToolPermissionContext } from "../tools/executor.js";
import { createWorkspaceRootRevocationFilter } from "../permissions/workspace-root-revocation.js";

export type PluginSurfacePermissionBase = Omit<
  ToolPermissionContext,
  "additionalDirectories" | "getAdditionalDirectories" | "onTurnDirectoryGrant" | "onSessionDirectoryGrant"
>;

export interface PluginSurfacePermissionScope {
  createPermissionContext(
    context: PluginToolInvocationContext,
    base: PluginSurfacePermissionBase,
  ): ToolPermissionContext;
  /**
   * Drop every session-scope grant covered by a removed workspace root, across
   * all plugin subjects. `ipc/domains/workspace.ts` drives this alongside the
   * conversation loops, the routine engine and the sub-agent runner, using the
   * SAME predicate they use — otherwise a grant taken on the plugin surface
   * outlives the root it was granted under for the app's lifetime.
   *
   * Turn-scope grants are per-invocation closures that die with the tool call,
   * so there is nothing durable to strip for them here.
   */
  revokeWorkspaceRoot(
    removedRoot: string,
    options?: { readonly preserveRoots?: readonly string[] },
  ): { sessionDirectoriesRemoved: number; turnDirectoriesRemoved: number };
}

export interface PluginSurfacePermissionScopeOptions {
  readPersistedDirectories: () => readonly string[];
  onSessionDirectoryAdded?: (subject: string, directory: string) => void;
  /** Fired when a workspace-root removal actually stripped plugin grants. */
  onSessionDirectoriesRevoked?: () => void;
}

export function pluginPermissionGrantSubject(context: PluginToolInvocationContext): string {
  return context.ownerPluginId ?? context.callerPluginId ?? "host";
}

export function createPluginSurfacePermissionScope(
  options: PluginSurfacePermissionScopeOptions,
): PluginSurfacePermissionScope {
  const sessionAdditionalDirectories = new Map<string, string[]>();

  const addSessionDirectory = (subject: string, directory: string): void => {
    const current = sessionAdditionalDirectories.get(subject) ?? [];
    if (current.includes(directory)) return;
    sessionAdditionalDirectories.set(subject, [...current, directory]);
    options.onSessionDirectoryAdded?.(subject, directory);
  };

  return {
    revokeWorkspaceRoot(
      removedRoot: string,
      revocation: { readonly preserveRoots?: readonly string[] } = {},
    ): { sessionDirectoriesRemoved: number; turnDirectoriesRemoved: number } {
      const isRevoked = createWorkspaceRootRevocationFilter(
        removedRoot,
        revocation.preserveRoots ?? [],
      );
      let sessionDirectoriesRemoved = 0;
      for (const [subject, directories] of sessionAdditionalDirectories) {
        const retained = directories.filter((directory) => !isRevoked(directory));
        if (retained.length === directories.length) continue;
        sessionDirectoriesRemoved += directories.length - retained.length;
        if (retained.length === 0) sessionAdditionalDirectories.delete(subject);
        else sessionAdditionalDirectories.set(subject, retained);
      }
      if (sessionDirectoriesRemoved > 0) options.onSessionDirectoriesRevoked?.();
      // `turnDirectoriesRemoved: 0` is not a stub — the sweep in
      // ipc/domains/workspace.ts requires both counts, and turn grants here live
      // in a per-invocation closure array that dies with the tool call, so there
      // is never a durable turn grant to strip.
      return { sessionDirectoriesRemoved, turnDirectoriesRemoved: 0 };
    },
    createPermissionContext(
      context: PluginToolInvocationContext,
      base: PluginSurfacePermissionBase,
    ): ToolPermissionContext {
      const subject = pluginPermissionGrantSubject(context);
      const turnAdditionalDirectories: string[] = [];
      const getAdditionalDirectories = (): readonly string[] => [
        ...options.readPersistedDirectories(),
        ...(sessionAdditionalDirectories.get(subject) ?? []),
        ...turnAdditionalDirectories,
      ];

      return {
        ...base,
        additionalDirectories: getAdditionalDirectories(),
        getAdditionalDirectories,
        onTurnDirectoryGrant: (directory) => {
          if (!turnAdditionalDirectories.includes(directory)) {
            turnAdditionalDirectories.push(directory);
          }
        },
        onSessionDirectoryGrant: (directory) => addSessionDirectory(subject, directory),
      };
    },
  };
}

/**
 * The live plugin-surface scope, published so the workspace-root removal sweep
 * in `ipc/domains/workspace.ts` can reach it. Boot creates exactly one scope
 * (`boot/steps/plugin-tool-executor.ts`); the sweep runs later, from IPC, so it
 * resolves the owner here rather than receiving it by value.
 */
let activePluginSurfacePermissionScope: PluginSurfacePermissionScope | undefined;

export function setActivePluginSurfacePermissionScope(
  scope: PluginSurfacePermissionScope | undefined,
): void {
  activePluginSurfacePermissionScope = scope;
}

export function getActivePluginSurfacePermissionScope():
  | PluginSurfacePermissionScope
  | undefined {
  return activePluginSurfacePermissionScope;
}
