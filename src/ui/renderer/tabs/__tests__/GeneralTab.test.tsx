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

function makeApi(overrides: Partial<LvisApi> = {}): LvisApi {
  const base = {
    listPluginUiExtensions: vi.fn().mockResolvedValue([{ pluginId: "a" }, { pluginId: "b" }]),
    listPluginCards: vi.fn().mockResolvedValue([
      { id: "a", name: "A", description: "", sampleTools: [], capabilities: [], tools: ["t1", "t2"] },
      { id: "b", name: "B", description: "", sampleTools: [], capabilities: [], tools: ["t3"] },
    ]),
    listAgentProfiles: vi.fn().mockResolvedValue({ agents: [{ name: "agent1" }, { name: "agent2" }] }),
    listSkills: vi.fn().mockResolvedValue({ skills: [{ name: "skill1" }] }),
    getSettings: vi.fn().mockResolvedValue({
      llm: { authMode: "manual", provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
      chat: { systemPrompt: "", autoCompact: true },
      roles: { presets: [{ id: "default", name: "기본", systemPromptAdd: "", isDefault: true }] },
      webSearch: { provider: "none" },
      features: {},
    }),
    pingMarketplace: vi.fn().mockResolvedValue({ configured: true, online: true }),
    getAppInfo: vi.fn().mockResolvedValue({
      version: "0.2.3",
      platform: "darwin",
      arch: "arm64",
      userDataPath: "/Users/test/Library/Application Support/LVIS",
    }),
    hasApiKey: vi.fn().mockResolvedValue(true),
    memoryGetUserPrefs: vi.fn().mockResolvedValue("- 사용자 호칭: 미정\n자기소개 한 줄"),
    onSettingsUpdated: vi.fn(() => () => {}),
    ...overrides,
  };
  return base as unknown as LvisApi;
}

describe("GeneralTab", () => {
  it("renders all 5 workspace stat cards with their counts", async () => {
    const api = makeApi();
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
    const api = makeApi();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("정상"));
  });

  it("calls onNavigate(plugin-config) when the 플러그인 card is clicked", async () => {
    const api = makeApi();
    const onNavigate = vi.fn();
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={onNavigate} />);
    const plugin = await findByTestId("general-tab-card-plugin");
    fireEvent.click(plugin);
    expect(onNavigate).toHaveBeenCalledWith("plugin-config");
  });

  it("renders the resolved app version + data path", async () => {
    const api = makeApi();
    const { findByTestId, findByText } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const version = await findByTestId("general-tab-app-version");
    await waitFor(() => expect(version.textContent).toContain("v0.2.3"));
    // The data path is informational text; assert presence via the
    // user-facing copy.
    await findByText("/Users/test/Library/Application Support/LVIS");
  });

  it("renders 미연결 when marketplace is not configured", async () => {
    const api = makeApi({
      pingMarketplace: vi.fn().mockResolvedValue({ configured: false, online: false }),
    });
    const { findByTestId } = render(<GeneralTab api={api} onNavigate={() => {}} />);
    const status = await findByTestId("general-tab-marketplace-status");
    await waitFor(() => expect(status.textContent).toContain("미연결"));
  });
});
