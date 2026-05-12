import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { shouldBlockGlobalWebviewNavigation } from "../webview-navigation-policy.js";

const distRoot = resolve("fixtures/LVIS.app/Contents/Resources/app.asar/dist");
const distSrcRoot = resolve(distRoot, "src");
const distSrcUrl = pathToFileURL(`${distSrcRoot}/`).toString();
const fileUrlInDistSrc = (name: string) => new URL(name, distSrcUrl).toString();

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
      currentUrl: fileUrlInDistSrc("plugin-ui-shell.html"),
      url: fileUrlInDistSrc("plugin-entry.js"),
    })).toBe(false);
    expect(decision({
      currentUrl: fileUrlInDistSrc("plugin-ui-shell.html"),
      url: "file:///etc/passwd",
    })).toBe(true);
  });

  it("keeps data and about navigations available for non-plugin preview frames", () => {
    expect(decision({ url: "data:text/html,ok" })).toBe(false);
    expect(decision({ url: "about:blank" })).toBe(false);
  });
});
