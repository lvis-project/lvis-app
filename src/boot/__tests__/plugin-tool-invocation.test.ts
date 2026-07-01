import { describe, expect, it } from "vitest";
import {
  isUiOnlyRuntimeInvocation,
  uiOnlyRuntimeInvocationRequiresUserAction,
} from "../plugin-tool-invocation.js";

function runtimeWithManifest(manifest: {
  tools?: string[];
  uiActions?: Record<string, { description?: string }>;
  auth?: { statusTool: string; loginTool: string; logoutTool?: string };
}) {
  return {
    listPluginManifests: () => [
      {
        pluginId: "meeting",
        manifest,
      },
    ],
  } as any;
}

describe("plugin UI-only runtime invocation", () => {
  it("routes UI action runtime methods that are not LLM tools through the UI action handler path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("routes uiActions runtime methods that are not LLM tools through the UI action handler path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("keeps LLM-facing tools on the ToolExecutor path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("does not bypass ToolExecutor for non-UI-origin calls", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ uiActions: { meeting_stage_upload_begin: {} } }),
        "meeting_stage_upload_begin",
        { origin: "plugin", ownerPluginId: "meeting" },
        "plugin",
      ),
    ).toBe(false);
  });

  it("requires the runtime method to be declared in the owning plugin uiActions list", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("keeps manifest tools on the ToolExecutor path even when registry sync is stale", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiActions: { meeting_upload_file: {} } }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("allows auth status polling without a fresh user activation", () => {
    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtimeWithManifest({
          tools: ["meeting_upload_file"],
          uiActions: { auth_status: {}, auth_login: {} },
          auth: { statusTool: "auth_status", loginTool: "auth_login" },
        }),
        "auth_status",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(false);
  });

  it("requires user activation for non-status UI-only actions", () => {
    const runtime = runtimeWithManifest({
      tools: ["meeting_upload_file"],
      uiActions: { auth_status: {}, auth_login: {}, meeting_stage_upload_begin: {} },
      auth: { statusTool: "auth_status", loginTool: "auth_login" },
    });

    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "auth_login",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(true);
    expect(
      uiOnlyRuntimeInvocationRequiresUserAction(
        runtime,
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
      ),
    ).toBe(true);
  });
});
