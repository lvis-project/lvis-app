/**
 * The plugin UI extension label — one derivation for the main-window sidebar
 * (`ui/renderer/api-client.ts`, consumed by App/Sidebar/command-actions) and
 * the plugin-shell bundle header (`plugin-ui-host.tsx`).
 *
 * Neither copy had a test before; the fallback chain is now pinned once, and
 * the type-level checks below pin that both consumer types still satisfy the
 * shared parameter, so the shared function cannot narrow away from its callers.
 */
import { describe, it, expect } from "vitest";
import {
  getPluginViewLabel,
  type PluginViewLabelSource,
} from "../plugin-view-label.js";
import type { PluginUiExtensionView } from "../../plugin-ui-host.js";
import type { PluginUiExtension } from "../../ui/renderer/types.js";

// Both consumer types must remain assignable to the shared parameter. These
// red at typecheck (not at runtime) if either shape drifts away from it.
const _hostViewIsAssignable: PluginViewLabelSource = {} as PluginUiExtensionView;
const _rendererViewIsAssignable: PluginViewLabelSource = {} as PluginUiExtension;
void _hostViewIsAssignable;
void _rendererViewIsAssignable;

function view(
  extension: Partial<PluginViewLabelSource["extension"]> & { title: string },
  pluginId = "com.acme.weather",
): PluginViewLabelSource {
  return { pluginId, extension };
}

describe("getPluginViewLabel", () => {
  it("prefers the author-chosen displayName", () => {
    expect(getPluginViewLabel(view({ displayName: "Weather", title: "Weather Panel" })))
      .toBe("Weather");
  });

  it("trims the displayName", () => {
    expect(getPluginViewLabel(view({ displayName: "  Weather  ", title: "Weather Panel" })))
      .toBe("Weather");
  });

  it("falls back to title when displayName is absent", () => {
    expect(getPluginViewLabel(view({ title: "Weather Panel" }))).toBe("Weather Panel");
  });

  it("falls back to title when displayName is blank once trimmed", () => {
    // An all-whitespace label would render as an invisible sidebar entry.
    expect(getPluginViewLabel(view({ displayName: "   ", title: "Weather Panel" })))
      .toBe("Weather Panel");
    expect(getPluginViewLabel(view({ displayName: "", title: "Weather Panel" })))
      .toBe("Weather Panel");
  });

  it("falls back to the plugin id when title is empty too", () => {
    expect(getPluginViewLabel(view({ displayName: "  ", title: "" }))).toBe("com.acme.weather");
    expect(getPluginViewLabel(view({ title: "" }, "com.acme.notes"))).toBe("com.acme.notes");
  });

  it("keeps inner whitespace — only the ends are trimmed", () => {
    expect(getPluginViewLabel(view({ displayName: " My  Weather ", title: "x" })))
      .toBe("My  Weather");
  });
});
