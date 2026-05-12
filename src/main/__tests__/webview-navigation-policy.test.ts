import { describe, expect, it } from "vitest";
import { shouldBlockGlobalWebviewNavigation } from "../webview-navigation-policy.js";

const distRoot = "/Applications/LVIS.app/Contents/Resources/app.asar/dist";

function decision(overrides: Partial<Parameters<typeof shouldBlockGlobalWebviewNavigation>[0]>) {
  return shouldBlockGlobalWebviewNavigation({
    url: "https://example.com/",
    currentUrl: "about:blank",
    distRoot,
    authOwned: false,
    linkOwned: false,
    ...overrides,
  });
}

describe("global webview navigation policy", () => {
  it("blocks unregistered http(s) webview navigations", () => {
    expect(decision({ url: "https://example.com/" })).toBe(true);
    expect(decision({ url: "http://example.com/" })).toBe(true);
  });

  it("delegates remote navigation only to explicitly owned auth/link webviews", () => {
    expect(decision({ url: "https://example.com/", authOwned: true })).toBe(false);
    expect(decision({ url: "https://example.com/", linkOwned: true })).toBe(false);
  });

  it("allows plugin shell file navigations only inside dist/src", () => {
    expect(decision({
      currentUrl: "file:///Applications/LVIS.app/Contents/Resources/app.asar/dist/src/plugin-ui-shell.html",
      url: "file:///Applications/LVIS.app/Contents/Resources/app.asar/dist/src/plugin-entry.js",
    })).toBe(false);
    expect(decision({
      currentUrl: "file:///Applications/LVIS.app/Contents/Resources/app.asar/dist/src/plugin-ui-shell.html",
      url: "file:///etc/passwd",
    })).toBe(true);
  });

  it("keeps data and about navigations available for non-plugin preview frames", () => {
    expect(decision({ url: "data:text/html,ok" })).toBe(false);
    expect(decision({ url: "about:blank" })).toBe(false);
  });
});
