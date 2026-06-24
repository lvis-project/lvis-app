/**
 * PluginUiHostView unit tests.
 *
 * Covers the loading-state lifecycle for non-webview paths and the
 * useEffect guard that prevents `loading=true` when no webview is rendered.
 *
 * Note: the webview race-guard (handleWebviewRef + isLoading()) cannot be
 * exercised in jsdom because Electron's <webview> tag is a native custom
 * element without a hyphen (customElements.define rejects "webview"). The
 * race-guard itself is tested at the integration level via the Electron
 * e2e suite. These unit tests cover the useEffect logic paths that are
 * fully exercisable in jsdom.
 */
import "../../../../test/renderer/setup.js";
import { describe, it, expect, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { PluginUiHostView } from "../../../plugin-ui-host.js";
import type { PluginUiExtensionView } from "../../../plugin-ui-host.js";

// ─── lvisApi stub ────────────────────────────────────────────────────────────

function stubLvisApi(shellUrl = "file:///dist/src/plugin-ui-shell.html", preloadUrl = "file:///dist/src/plugin-preload.cjs") {
  (window as unknown as Record<string, unknown>).lvisApi = {
    pluginShellUrl: shellUrl,
    pluginPreloadUrl: preloadUrl,
  };
}

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).lvisApi;
});

// ─── Fixture ──────────────────────────────────────────────────────────────────

function makeView(overrides: Partial<PluginUiExtensionView> = {}): PluginUiExtensionView {
  return {
    pluginId: "meeting",
    extension: {
      id: "meeting-control",
      slot: "sidebar",
      kind: "embedded-module",
      title: "미팅",
      description: "회의 세션 테스트",
      entry: "dist/ui/meeting-control.js",
    },
    entryUrl: "file:///plugins/meeting/dist/ui/meeting-control.js",
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("PluginUiHostView — loading state", () => {
  it("does NOT show loading overlay when view is null", () => {
    stubLvisApi();
    const { queryByText } = render(<PluginUiHostView view={null} />);
    expect(queryByText("로딩 중...")).toBeNull();
  });

  it("shows error message when view is null", () => {
    stubLvisApi();
    const { getByText } = render(<PluginUiHostView view={null} />);
    expect(getByText("플러그인 뷰를 찾을 수 없습니다.")).toBeTruthy();
  });

  it("does NOT show loading overlay when view.entryUrl is missing", () => {
    stubLvisApi();
    const { queryByText } = render(<PluginUiHostView view={makeView({ entryUrl: undefined })} />);
    // No webview rendered — loading must stay false to avoid permanent overlay.
    expect(queryByText("로딩 중...")).toBeNull();
  });

  it("shows 'UI 모듈 엔트리를 찾을 수 없습니다.' when entryUrl is missing", () => {
    stubLvisApi();
    const { getByText } = render(<PluginUiHostView view={makeView({ entryUrl: undefined })} />);
    expect(getByText("UI 모듈 엔트리를 찾을 수 없습니다.")).toBeTruthy();
  });

  it("does NOT show loading overlay when pluginShellUrl is missing from lvisApi", () => {
    stubLvisApi("", "file:///preload.cjs"); // empty shellUrl → no webview
    const { queryByText } = render(<PluginUiHostView view={makeView()} />);
    expect(queryByText("로딩 중...")).toBeNull();
  });

  it("does NOT show loading overlay when pluginPreloadUrl is missing from lvisApi", () => {
    stubLvisApi("file:///plugin-ui-shell.html", ""); // empty preloadUrl → no webview
    const { queryByText } = render(<PluginUiHostView view={makeView()} />);
    expect(queryByText("로딩 중...")).toBeNull();
  });

  it("shows asset URL error message when pluginShellUrl is missing", () => {
    stubLvisApi("", "file:///preload.cjs");
    const { getByText } = render(<PluginUiHostView view={makeView()} />);
    expect(getByText(/Plugin webview 자산 URL을 lvisApi에서 찾을 수 없습니다/)).toBeTruthy();
  });

  it("omits host card chrome when showChrome is false", () => {
    stubLvisApi("", "file:///preload.cjs");
    const { queryByText, getByText } = render(<PluginUiHostView view={makeView()} showChrome={false} />);
    expect(queryByText("미팅")).toBeNull();
    expect(queryByText("회의 세션 테스트")).toBeNull();
    expect(getByText(/Plugin webview 자산 URL을 lvisApi에서 찾을 수 없습니다/)).toBeTruthy();
  });

  it("shows auth error banner above inline plugin content", () => {
    stubLvisApi("", "file:///preload.cjs");
    const { getByText } = render(
      <PluginUiHostView view={makeView()} authError="플러그인 로그인 실패 code: non-corp-network" />,
    );
    expect(getByText("플러그인 로그인 실패 code: non-corp-network")).toBeTruthy();
    expect(getByText(/Plugin webview 자산 URL을 lvisApi에서 찾을 수 없습니다/)).toBeTruthy();
  });

  it("shows auth error banner for detached plugin content", () => {
    stubLvisApi("", "file:///preload.cjs");
    const { getByText } = render(
      <PluginUiHostView
        view={makeView()}
        showChrome={false}
        authError="플러그인 로그인 실패 code: non-corp-network"
      />,
    );
    expect(getByText("플러그인 로그인 실패 code: non-corp-network")).toBeTruthy();
  });

  it("does NOT show loading overlay for embedded-page kind (legacy)", () => {
    stubLvisApi();
    const view = makeView();
    view.extension.kind = "embedded-page";
    const { queryByText } = render(<PluginUiHostView view={view} />);
    expect(queryByText("로딩 중...")).toBeNull();
  });
});
