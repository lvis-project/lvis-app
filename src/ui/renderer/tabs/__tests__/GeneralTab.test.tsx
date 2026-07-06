/**
 * GeneralTab — renders 계정 / 워크스페이스 / 시스템 sections from the
 * existing renderer API surface. The test stubs the LvisApi with the
 * subset of methods GeneralTab + useWorkspaceStats touch and asserts:
 *   1. all 5 stat cards render with their counts after IPC resolves
 *   2. marketplace status pill reflects the `pingMarketplace` result
 *   3. clicking a stat card navigates via `onNavigate`
 *   4. system section renders the resolved app version + data path
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { GeneralTab } from "../GeneralTab.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { marketplaceProviderPresetSecretId } from "../../../../shared/marketplace-package-assets.js";

const GENERAL_SETTINGS = {
  llm: { authMode: "manual", provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  features: {},
};

const GENERAL_APP_INFO = {
  version: "0.2.3",
  electronVersion: "41.6.1",
  nodeVersion: "22.4.0",
  chromeVersion: "131.0.6778.0",
  v8Version: "13.1.201.13",
  platform: "darwin",
  arch: "arm64",
  userDataPath: "/Users/test/Library/Application Support/LVIS",
};

function generalTabApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const { api } = makeMockLvisApi({
    pluginUiExtensions: [{ pluginId: "a" }, { pluginId: "b" }],
    pluginCards: [
      { id: "a", name: "A", description: "", sampleTools: [], capabilities: [], tools: ["t1", "t2"] },
      { id: "b", name: "B", description: "", sampleTools: [], capabilities: [], tools: ["t3"] },
    ],
    agentProfiles: { agents: [{ name: "agent1" }, { name: "agent2" }] },
    skills: { skills: [{ name: "skill1" }] },
    personaPrompts: [{ id: "persona1", name: "Persona", systemPromptAdd: "Act as persona." }],
    settings: GENERAL_SETTINGS,
    appInfo: GENERAL_APP_INFO,
  });
  Object.assign(api, overrides);
  return api as unknown as LvisApi;
}

describe("GeneralTab", () => {
  it("renders all 5 workspace stat cards with their counts", async () => {
    const api = generalTabApi();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const plugin = await findByTestId("general-tab-card-plugin");
    const tool = await findByTestId("general-tab-card-tool");
    const agent = await findByTestId("general-tab-card-agent");
    const skill = await findByTestId("general-tab-card-skill");
    const role = await findByTestId("general-tab-card-role");

    await waitFor(() => {
      expect(plugin.textContent).toContain("2");
      expect(tool.textContent).toContain("3");
      expect(agent.textContent).toContain("2");
      expect(skill.textContent).toContain("1");
      expect(role.textContent).toContain("1");
    });
  });

  it("renders marketplace status pill with the resolved online state", async () => {
    const api = generalTabApi();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("정상"));
  });

  it("calls onNavigate(plugin-config) when the 플러그인 card is clicked", async () => {
    const api = generalTabApi();
    const onNavigate = vi.fn();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={onNavigate} />);
    const plugin = await findByTestId("general-tab-card-plugin");
    fireEvent.click(plugin);
    expect(onNavigate).toHaveBeenCalledWith("plugin-config");
  });

  it("renders the resolved app version + data path", async () => {
    const api = generalTabApi();
    const { findByTestId, findByText } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const version = await findByTestId("general-tab-app-version");
    await waitFor(() => expect(version.textContent).toContain("v0.2.3"));
    // The data path is informational text; assert presence via the
    // user-facing copy.
    await findByText("/Users/test/Library/Application Support/LVIS");
  });

  it("renders the resolved 기반 기술 stack (Electron / Node / Chromium / V8)", async () => {
    const api = generalTabApi();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const electron = await findByTestId("general-tab-stack-electron");
    const node = await findByTestId("general-tab-stack-node");
    const chrome = await findByTestId("general-tab-stack-chrome");
    const v8 = await findByTestId("general-tab-stack-v8");
    await waitFor(() => {
      expect(electron.textContent).toContain("41.6.1");
      expect(node.textContent).toContain("22.4.0");
      expect(chrome.textContent).toContain("131.0.6778.0");
      expect(v8.textContent).toContain("13.1.201.13");
    });
  });

  it("renders 미연결 when marketplace is not configured", async () => {
    const api = generalTabApi({
      pingMarketplace: vi.fn().mockResolvedValue({ configured: false, online: false }),
    });
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("미연결"));
  });

  // 2026-05-20 — 인증 관리 section: 로그아웃 / 활성화 키 재입력
  it("renders 인증 관리 buttons (reactivate + logout)", async () => {
    const api = generalTabApi();
    const { findByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onLogout={() => {}} onReactivateDemo={() => {}} />,
    );
    const reactivate = await findByTestId("general-tab-reactivate-demo");
    const logout = await findByTestId("general-tab-logout");
    expect(reactivate.textContent).toContain("활성화 키 재입력");
    expect(logout.textContent).toContain("로그아웃");
  });

  it("invokes onReactivateDemo when the 활성화 키 재입력 button is clicked", async () => {
    const api = generalTabApi();
    const onReactivateDemo = vi.fn();
    const { findByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onReactivateDemo={onReactivateDemo} />,
    );
    fireEvent.click(await findByTestId("general-tab-reactivate-demo"));
    expect(onReactivateDemo).toHaveBeenCalledTimes(1);
  });

  it("로그아웃 클릭 → confirm dialog → 확인 시 active vendor 의 deleteApiKey + demo clear + onboardingCompleted=false + onLogout", async () => {
    const api = generalTabApi();
    const onLogout = vi.fn();
    const { findByTestId, queryByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onLogout={onLogout} onReactivateDemo={() => {}} />,
    );
    // settings 가 fetch 되어 provider 가 채워진 뒤 클릭하도록 stat card 가
    // 먼저 render 되었는지 기다린다.
    await findByTestId("general-tab-card-plugin");

    fireEvent.click(await findByTestId("general-tab-logout"));
    const confirm = await findByTestId("general-tab-logout-confirm-button");
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(api.deleteApiKey).toHaveBeenCalledWith("openai");
      expect(api.demo.clearDemo).toHaveBeenCalledTimes(1);
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: { authMode: "manual" },
        features: { onboardingCompleted: false },
      });
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
    // confirm dialog 가 닫혔는지
    await waitFor(() =>
      expect(queryByTestId("general-tab-logout-confirm")).toBeNull(),
    );
  });

  it("custom marketplace provider logout deletes the preset-scoped API key", async () => {
    const presetId = "future-router";
    const api = generalTabApi({
      getSettings: vi.fn().mockResolvedValue({
        ...GENERAL_SETTINGS,
        llm: {
          ...GENERAL_SETTINGS.llm,
          provider: "openai-compatible",
          marketplaceProviderPresetId: presetId,
        },
      }),
    });
    const onLogout = vi.fn();
    const { findByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onLogout={onLogout} onReactivateDemo={() => {}} />,
    );
    await findByTestId("general-tab-card-plugin");

    fireEvent.click(await findByTestId("general-tab-logout"));
    fireEvent.click(await findByTestId("general-tab-logout-confirm-button"));

    await waitFor(() => {
      expect(api.deleteApiKey).toHaveBeenCalledWith(
        marketplaceProviderPresetSecretId(presetId),
      );
      expect(api.demo.clearDemo).toHaveBeenCalledTimes(1);
      expect(onLogout).toHaveBeenCalledTimes(1);
    });
  });

  it("clearDemo 가 실패하면 onLogout 을 호출하지 않고 error 메시지를 노출", async () => {
    const api = generalTabApi({
      demo: {
        status: vi.fn(),
        activate: vi.fn(),
        relaunchAfterActivation: vi.fn(),
        clearDemo: vi.fn().mockResolvedValue({ ok: false, error: "clear-failed" }),
      } as unknown as LvisApi["demo"],
    });
    const onLogout = vi.fn();
    const { findByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onLogout={onLogout} />,
    );
    await findByTestId("general-tab-card-plugin");
    fireEvent.click(await findByTestId("general-tab-logout"));
    fireEvent.click(await findByTestId("general-tab-logout-confirm-button"));
    await findByTestId("general-tab-logout-error");
    expect(onLogout).not.toHaveBeenCalled();
  });

  it("active vendor 키 삭제가 실패하면 demo clear/onLogout 없이 fail-closed", async () => {
    const api = generalTabApi({
      deleteApiKey: vi.fn().mockRejectedValue(new Error("keychain failed")),
    });
    const onLogout = vi.fn();
    const { findByTestId } = render(
      <GeneralTab api={api} onNavigate={() => {}} onLogout={onLogout} />,
    );
    await findByTestId("general-tab-card-plugin");
    fireEvent.click(await findByTestId("general-tab-logout"));
    fireEvent.click(await findByTestId("general-tab-logout-confirm-button"));

    const err = await findByTestId("general-tab-logout-error");
    expect(err.textContent).toContain("API 키 삭제");
    expect(api.demo.clearDemo).not.toHaveBeenCalled();
    expect(api.updateSettings).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
