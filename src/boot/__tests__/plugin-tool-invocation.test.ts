import { describe, expect, it } from "vitest";
import { isUiOnlyRuntimeInvocation } from "../plugin-tool-invocation.js";

function runtimeWithManifest(manifest: { tools?: string[]; uiCallable?: string[] }) {
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
  it("routes UI-callable runtime methods that are not LLM tools outside ToolExecutor", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiCallable: ["meeting_stage_upload_begin"] }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(true);
  });

  it("keeps LLM-facing tools on the ToolExecutor path", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiCallable: ["meeting_upload_file"] }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("does not bypass ToolExecutor for non-UI-origin calls", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ uiCallable: ["meeting_stage_upload_begin"] }),
        "meeting_stage_upload_begin",
        { origin: "plugin", ownerPluginId: "meeting" },
        "plugin",
      ),
    ).toBe(false);
  });

  it("requires the runtime method to be declared in the owning plugin uiCallable list", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiCallable: ["meeting_upload_file"] }),
        "meeting_stage_upload_begin",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });

  it("keeps manifest tools on the ToolExecutor path even when registry sync is stale", () => {
    expect(
      isUiOnlyRuntimeInvocation(
        runtimeWithManifest({ tools: ["meeting_upload_file"], uiCallable: ["meeting_upload_file"] }),
        "meeting_upload_file",
        { origin: "ui", ownerPluginId: "meeting" },
        "ui",
      ),
    ).toBe(false);
  });
});
