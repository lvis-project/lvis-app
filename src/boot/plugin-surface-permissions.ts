import type { PluginToolInvocationContext } from "../plugins/runtime/index.js";
import type { ToolPermissionContext } from "../tools/executor.js";

export type PluginSurfacePermissionBase = Omit<
  ToolPermissionContext,
  | "additionalDirectories"
  | "getAdditionalDirectories"
  | "onTurnDirectoryGrant"
  | "onSessionDirectoryGrant"
  // Omitted for the same reason as the sinks above: the grant subject is
  // derived here from the invocation context, and a base allowed to carry one
  // would let the caller name whose grant counter its denials are credited to.
  | "directoryGrantSubject"
>;

export interface PluginSurfacePermissionScope {
  createPermissionContext(
    context: PluginToolInvocationContext,
    base: PluginSurfacePermissionBase,
  ): ToolPermissionContext;
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
        // Assigned after the spread: the subject the denial counter credits
        // must be the same subject `addSessionDirectory` writes to, decided
        // here and nowhere else.
        directoryGrantSubject: subject,
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
