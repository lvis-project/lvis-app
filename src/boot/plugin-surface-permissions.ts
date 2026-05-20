import type { PluginToolInvocationContext } from "../plugins/runtime/index.js";
import type { ToolPermissionContext } from "../tools/executor.js";

export type PluginSurfacePermissionBase = Omit<
  ToolPermissionContext,
  "additionalDirectories" | "getAdditionalDirectories" | "onTurnDirectoryGrant" | "onSessionDirectoryGrant"
>;

export interface PluginSurfacePermissionScope {
  createPermissionContext(
    context: PluginToolInvocationContext,
    base: PluginSurfacePermissionBase,
  ): ToolPermissionContext;
  getSessionDirectories(subject: string): readonly string[];
}

export interface PluginSurfacePermissionScopeOptions {
  readPersistedDirectories: () => readonly string[];
  onSessionDirectoryAdded?: (subject: string, directory: string) => void;
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
    getSessionDirectories(subject: string): readonly string[] {
      return sessionAdditionalDirectories.get(subject) ?? [];
    },
  };
}
