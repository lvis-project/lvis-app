import { describe, expect, it, vi } from "vitest";
import {
  createPluginSurfacePermissionScope,
  pluginPermissionGrantSubject,
} from "../plugin-surface-permissions.js";

describe("pluginPermissionGrantSubject", () => {
  it("scopes grants to the owner plugin before the caller plugin", () => {
    expect(pluginPermissionGrantSubject({
      origin: "ui",
      ownerPluginId: "local-indexer",
      callerPluginId: "work-assistant",
    })).toBe("local-indexer");

    expect(pluginPermissionGrantSubject({
      origin: "ui",
      callerPluginId: "work-assistant",
    })).toBe("work-assistant");

    expect(pluginPermissionGrantSubject({ origin: "ui" })).toBe("host");
  });
});

describe("createPluginSurfacePermissionScope", () => {
  it("persists session grants by plugin subject and keeps turn grants per invocation", () => {
    const onSessionDirectoryAdded = vi.fn();
    let persistedDirectories = ["/persisted"];
    const scope = createPluginSurfacePermissionScope({
      readPersistedDirectories: () => persistedDirectories,
      onSessionDirectoryAdded,
    });
    const indexerContext = {
      origin: "ui" as const,
      ownerPluginId: "local-indexer",
      callerPluginId: "work-assistant",
    };

    const first = scope.createPermissionContext(indexerContext, {
      headless: false,
      trustOrigin: "plugin-emitted",
    });

    expect(first.additionalDirectories).toEqual(["/persisted"]);
    first.onSessionDirectoryGrant?.("/grant/session");
    first.onSessionDirectoryGrant?.("/grant/session");
    expect(onSessionDirectoryAdded).toHaveBeenCalledTimes(1);
    expect(onSessionDirectoryAdded).toHaveBeenCalledWith("local-indexer", "/grant/session");
    expect(first.getAdditionalDirectories?.()).toEqual(["/persisted", "/grant/session"]);

    const samePlugin = scope.createPermissionContext(indexerContext, {
      headless: false,
      trustOrigin: "plugin-emitted",
    });
    expect(samePlugin.getAdditionalDirectories?.()).toEqual(["/persisted", "/grant/session"]);

    const differentPlugin = scope.createPermissionContext({
      origin: "ui",
      ownerPluginId: "meeting",
    }, {
      headless: false,
      trustOrigin: "plugin-emitted",
    });
    expect(differentPlugin.getAdditionalDirectories?.()).toEqual(["/persisted"]);

    samePlugin.onTurnDirectoryGrant?.("/grant/turn");
    samePlugin.onTurnDirectoryGrant?.("/grant/turn");
    expect(samePlugin.getAdditionalDirectories?.()).toEqual([
      "/persisted",
      "/grant/session",
      "/grant/turn",
    ]);

    const laterSamePlugin = scope.createPermissionContext(indexerContext, {
      headless: false,
      trustOrigin: "plugin-emitted",
    });
    expect(laterSamePlugin.getAdditionalDirectories?.()).toEqual(["/persisted", "/grant/session"]);

    persistedDirectories = ["/persisted", "/settings-added"];
    expect(laterSamePlugin.getAdditionalDirectories?.()).toEqual([
      "/persisted",
      "/settings-added",
      "/grant/session",
    ]);
    expect(scope.getSessionDirectories("local-indexer")).toEqual(["/grant/session"]);
  });
});
