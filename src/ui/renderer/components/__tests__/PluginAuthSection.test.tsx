import "../../../../../test/renderer/setup.ts";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PluginAuthSection } from "../PluginAuthSection.js";
import type { LvisApi, PluginAuthSummary } from "../../types.js";
import type { PluginAuthState } from "../../hooks/use-plugin-auth-status.js";

const baseAuth: PluginAuthSummary = {
  label: "Microsoft 계정",
  statusTool: "ms_status",
  loginTool: "ms_login",
  logoutTool: "ms_signout",
};

function makeApi(overrides?: Partial<LvisApi>): LvisApi {
  const callPluginMethod = vi.fn(async () => ({ authenticated: true }));
  return {
    callPluginMethod,
    onPluginEvent: vi.fn(() => () => undefined),
    ...overrides,
  } as unknown as LvisApi;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PluginAuthSection", () => {
  it("renders 미인증 badge + 로그인 button when state is unauthed", () => {
    const api = makeApi();
    render(
      <PluginAuthSection
        api={api}
        pluginId="ms-graph"
        pluginName="ms-graph"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("🔒 미인증")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-login-ms-graph")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-ms-graph")).toBeNull();
  });

  it("renders 인증됨 badge + account + 로그아웃 button when state is authed", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="ms-graph"
        pluginName="ms-graph"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.getByText("user@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("plugin-auth-logout-ms-graph")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-login-ms-graph")).toBeNull();
  });

  it("hides 로그아웃 button when manifest does not declare logoutTool", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="lge-api"
        pluginName="lge-api"
        auth={{ statusTool: "lge_status", loginTool: "lge_login" }}
        state={{ kind: "authed", account: "kimx@lge.com" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("✓ 인증됨")).toBeInTheDocument();
    expect(screen.queryByTestId("plugin-auth-logout-lge-api")).toBeNull();
  });

  it("invokes loginTool + onRefresh when 로그인 clicked", async () => {
    const api = makeApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="ms-graph"
        pluginName="ms-graph"
        auth={baseAuth}
        state={{ kind: "unauthed" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-login-ms-graph"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_login");
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("invokes logoutTool + onRefresh when 로그아웃 clicked", async () => {
    const api = makeApi();
    const onRefresh = vi.fn();
    render(
      <PluginAuthSection
        api={api}
        pluginId="ms-graph"
        pluginName="ms-graph"
        auth={baseAuth}
        state={{ kind: "authed", account: "user@example.com" }}
        onRefresh={onRefresh}
      />,
    );
    fireEvent.click(screen.getByTestId("plugin-auth-logout-ms-graph"));
    await waitFor(() => {
      expect(api.callPluginMethod).toHaveBeenCalledWith("ms_signout");
    });
    expect(onRefresh).toHaveBeenCalled();
  });

  it("falls back to pluginName when auth.label is empty", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="x"
        pluginName="Cool Plugin"
        auth={{ statusTool: "x_status", loginTool: "x_login" }}
        state={{ kind: "unauthed" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("Cool Plugin")).toBeInTheDocument();
  });

  it("renders error badge when state is error", () => {
    render(
      <PluginAuthSection
        api={makeApi()}
        pluginId="x"
        pluginName="x"
        auth={baseAuth}
        state={{ kind: "error", message: "boom" }}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText("⚠ 오류")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});
