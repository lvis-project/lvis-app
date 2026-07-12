/**
 * `mcp-app-permissions` — the single mapping table from a resource's declared
 * `_meta.ui.permissions` to (1) the inner-frame `allow` attribute and (2) the Electron
 * session grant. These are pure-function tests of the HOST-COMPUTED, fail-closed policy;
 * the real-<webview> proof that Chromium HONORS the result lives in
 * `test/e2e/ui/mcp-app-permissions.spec.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_APP_PERMISSION_FEATURES,
  buildMcpAppAllowAttr,
  declaredFeatures,
  isElectronPermissionGranted,
} from "../mcp-app-permissions.js";
import type { McpUiResourcePermissions } from "../../mcp/types.js";

describe("the host capability table", () => {
  it("carries ONLY the features proven to work end-to-end (camera, microphone, geolocation)", () => {
    expect(MCP_APP_PERMISSION_FEATURES.map((f) => f.key)).toEqual([
      "camera",
      "microphone",
      "geolocation",
    ]);
    // clipboardWrite is deliberately excluded — measured denied even when delegated.
    expect(MCP_APP_PERMISSION_FEATURES.some((f) => f.key === "clipboardWrite")).toBe(false);
  });
});

describe("buildMcpAppAllowAttr — the host-computed inner-frame allow-list", () => {
  it("declared ⇒ exactly the declared, table-known tokens, in TABLE order", () => {
    // Declaration order is geolocation-then-camera; the output is table order.
    expect(buildMcpAppAllowAttr({ geolocation: {}, camera: {} })).toBe("camera; geolocation");
    expect(buildMcpAppAllowAttr({ camera: {}, microphone: {}, geolocation: {} })).toBe(
      "camera; microphone; geolocation",
    );
  });

  it("undeclared / empty / undefined ⇒ empty string (fail-closed: no allow attribute)", () => {
    expect(buildMcpAppAllowAttr(undefined)).toBe("");
    expect(buildMcpAppAllowAttr({})).toBe("");
  });

  it("a spec feature the host cannot honor (clipboardWrite) is NEVER delegated, even if declared", () => {
    expect(buildMcpAppAllowAttr({ clipboardWrite: {} })).toBe("");
    expect(buildMcpAppAllowAttr({ camera: {}, clipboardWrite: {} })).toBe("camera");
  });
});

describe("isElectronPermissionGranted — the fail-closed session decision", () => {
  it("grants a declared feature's Electron permission", () => {
    expect(isElectronPermissionGranted({ geolocation: {} }, "geolocation")).toBe(true);
    expect(isElectronPermissionGranted({ camera: {} }, "media", ["video"])).toBe(true);
    expect(isElectronPermissionGranted({ microphone: {} }, "media", ["audio"])).toBe(true);
  });

  it("denies an undeclared feature, an absent declaration, and an unmodelled permission", () => {
    expect(isElectronPermissionGranted({ geolocation: {} }, "media", ["video"])).toBe(false);
    expect(isElectronPermissionGranted(undefined, "geolocation")).toBe(false);
    expect(isElectronPermissionGranted({}, "geolocation")).toBe(false);
    expect(isElectronPermissionGranted({ geolocation: {} }, "notifications")).toBe(false);
    // clipboardWrite is not in the table, so declaring it grants nothing at this layer.
    expect(isElectronPermissionGranted({ clipboardWrite: {} }, "clipboard-sanitized-write")).toBe(
      false,
    );
  });

  it("media-kind split: a mic-only card gets its mic and is DENIED the camera (and vice versa)", () => {
    const micOnly: McpUiResourcePermissions = { microphone: {} };
    expect(isElectronPermissionGranted(micOnly, "media", ["audio"])).toBe(true);
    expect(isElectronPermissionGranted(micOnly, "media", ["video"])).toBe(false);

    const camOnly: McpUiResourcePermissions = { camera: {} };
    expect(isElectronPermissionGranted(camOnly, "media", ["video"])).toBe(true);
    expect(isElectronPermissionGranted(camOnly, "media", ["audio"])).toBe(false);
  });

  it("a combined video+audio media request needs BOTH declared (fail-closed)", () => {
    expect(
      isElectronPermissionGranted({ camera: {}, microphone: {} }, "media", ["video", "audio"]),
    ).toBe(true);
    expect(isElectronPermissionGranted({ microphone: {} }, "media", ["video", "audio"])).toBe(false);
  });

  it("without a media kind, falls back to the coarse string match (the strict check is the request handler's)", () => {
    // A `media` ask/check that carries no kind still requires SOME media feature declared.
    expect(isElectronPermissionGranted({ microphone: {} }, "media")).toBe(true);
    expect(isElectronPermissionGranted({ geolocation: {} }, "media")).toBe(false);
  });
});

describe("declaredFeatures", () => {
  it("filters to declared, table-known keys (drops clipboardWrite and unknowns)", () => {
    expect(declaredFeatures({ camera: {}, clipboardWrite: {} }).map((f) => f.key)).toEqual([
      "camera",
    ]);
    expect(declaredFeatures(undefined)).toEqual([]);
    expect(declaredFeatures({})).toEqual([]);
  });
});
