import "../../../../test/renderer/setup.js";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { PluginConfigTab } from "../tabs/PluginConfigTab.js";
import { PluginConfigSchemaForm } from "../tabs/PluginConfigSchemaForm.js";

const mockCards = vi.fn(async () => [
  {
    id: "meeting",
    name: "Meeting",
    description: "Meeting plugin",
    publisher: "Test fixture",
    sampleTools: [],
    capabilities: [],
    tools: [],
    loadStatus: "loaded" as const,
  },
]);
const mockGet = vi.fn(async () => ({ ok: true as const, config: { apiKey: "abc" } }));
const mockSet = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "권한이 없는 프레임입니다.",
}));
const mockUninstall = vi.fn(async () => ({
  ok: false as const,
  error: "unauthorized-frame",
  message: "제거 권한이 없습니다.",
}));

beforeEach(() => {
  Object.defineProperty(window, "lvis", {
    value: {
      plugins: {
        cards: mockCards,
      },
      pluginConfig: {
        get: mockGet,
        set: mockSet,
      },
    },
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "lvisHost", {
    value: {
      takePluginMarketplaceApi: () => ({
        installMarketplacePlugin: vi.fn(),
        uninstallMarketplacePlugin: mockUninstall,
      }),
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, "lvis", {
    value: undefined,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "lvisHost", {
    value: undefined,
    writable: true,
    configurable: true,
  });
});

describe("PluginConfigTab", () => {
  it("shows uninstall failure instead of success when IPC returns ok=false", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "제거" }));

    await waitFor(() => {
      expect(mockUninstall).toHaveBeenCalledWith("meeting");
      expect(screen.getByText("제거 권한이 없습니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("Meeting 제거 완료")).toBeNull();
    confirmSpy.mockRestore();
  });

  it("shows save failure instead of success when IPC returns ok=false", async () => {
    render(<PluginConfigTab />);

    await waitFor(() => {
      expect(mockCards).toHaveBeenCalledOnce();
      expect(mockGet).toHaveBeenCalledWith("meeting");
    });

    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(mockSet).toHaveBeenCalledOnce();
      expect(screen.getByText("권한이 없는 프레임입니다.")).toBeInTheDocument();
    });

    expect(screen.queryByText("설정이 저장되었습니다.")).toBeNull();
  });
});

describe("PluginConfigTab — §9.2 Track B configSchema rendering", () => {
  it("renders the typed form when manifest declares configSchema and routes secrets through setSecret", async () => {
    // Override the cards mock with a plugin that declares a typed schema
    // including one secret key.
    const mockCardsTyped = vi.fn(async () => [
      {
        id: "with-schema",
        name: "Schema Plugin",
        description: "Has configSchema",
        publisher: "Test fixture",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        configSchema: {
          properties: {
            endpoint: { type: "string", title: "Endpoint", default: "https://api" },
            apiKey: { type: "string", format: "secret", title: "API Key" },
          },
        },
      },
    ]);
    const mockGetTyped = vi.fn(async () => ({ ok: true as const, config: {} }));
    const mockSetTyped = vi.fn(async () => ({ ok: true as const, config: { endpoint: "https://api" } }));
    const mockSetSecret = vi.fn(async () => ({ ok: true as const }));

    Object.defineProperty(window, "lvis", {
      value: {
        plugins: { cards: mockCardsTyped },
        pluginConfig: {
          get: mockGetTyped,
          set: mockSetTyped,
          getSchema: vi.fn(),
          setSecret: mockSetSecret,
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "lvisHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    // The schema-driven form renders fields with deriveLabel("Endpoint"/"API Key").
    await waitFor(() => {
      expect(screen.getByText("Endpoint")).toBeInTheDocument();
      expect(screen.getByText("API Key")).toBeInTheDocument();
    });

    // Legacy raw-KV editor must NOT render — the "+ 추가" button is the marker.
    expect(screen.queryByText("+ 추가")).toBeNull();

    // Type a secret value, click its dedicated 저장 button. setSecret MUST
    // be called (NOT pluginConfig.set with the cleartext value).
    const secretInputs = document.querySelectorAll('input[type="password"]');
    expect(secretInputs.length).toBe(1);
    fireEvent.change(secretInputs[0], { target: { value: "sk-LIVE" } });
    const saveButtons = screen.getAllByRole("button", { name: /저장/ });
    // The first 저장 button belongs to the secret row; the form-level
    // 저장 lives further down. We click the secret one explicitly via test id.
    const secretSaveBtn = document.querySelector(
      '[data-testid="pcfg:with-schema:apiKey:save"]',
    ) as HTMLButtonElement;
    expect(secretSaveBtn).not.toBeNull();
    fireEvent.click(secretSaveBtn);
    await waitFor(() => {
      expect(mockSetSecret).toHaveBeenCalledWith("with-schema", "apiKey", "sk-LIVE");
      expect(mockSetTyped).not.toHaveBeenCalledWith(
        "with-schema",
        expect.objectContaining({ apiKey: "sk-LIVE" }),
      );
    });

    // Sanity: form-level 저장 button still exists for cleartext fields.
    expect(saveButtons.length).toBeGreaterThan(0);
  });

  it("falls back to the legacy raw key/value editor when manifest has NO configSchema", async () => {
    // Use the original mock from the outer `beforeEach`. Re-install here
    // explicitly because this describe block does not share the parent's
    // hooks.
    Object.defineProperty(window, "lvis", {
      value: {
        plugins: { cards: mockCards },
        pluginConfig: { get: mockGet, set: mockSet },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "lvisHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    // Legacy `+ 추가` button proves the raw KV editor is used.
    await waitFor(() => {
      expect(screen.getByText("+ 추가")).toBeInTheDocument();
    });
  });
});

describe("PluginConfigTab — auth UI", () => {
  it("uses loginTool even when a plugin also declares detached UI views", async () => {
    const cards = vi.fn(async () => [
      {
        id: "token-plugin",
        name: "Token Plugin",
        description: "Uses plugin UI auth",
        sampleTools: [],
        capabilities: [],
        tools: [],
        loadStatus: "loaded" as const,
        auth: {
          label: "Token auth",
          statusTool: "token_status",
          loginTool: "token_login",
          logoutTool: "token_logout",
        },
      },
    ]);
    const callPluginMethod = vi.fn(async (tool: string) =>
      tool === "token_status" ? { authenticated: false } : { ok: true },
    );

    Object.defineProperty(window, "lvis", {
      value: {
        plugins: { cards },
        pluginConfig: {
          get: vi.fn(async () => ({ ok: true as const, config: {} })),
          set: vi.fn(async () => ({ ok: true as const, config: {} })),
          listSecretKeys: vi.fn(async () => ({ ok: true as const, keys: [] })),
        },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "lvisApi", {
      value: {
        callPluginMethod,
        onPluginEvent: vi.fn(() => () => undefined),
        listPluginUiExtensions: vi.fn(async () => []),
        window: { openDetached: vi.fn(async () => ({ ok: true as const, windowId: 7 })) },
      },
      writable: true,
      configurable: true,
    });
    Object.defineProperty(window, "lvisHost", {
      value: { takePluginMarketplaceApi: () => null },
      writable: true,
      configurable: true,
    });

    render(<PluginConfigTab />);

    const loginButton = await screen.findByTestId("plugin-auth-login-token-plugin");
    expect(loginButton).toHaveTextContent("로그인");
    fireEvent.click(loginButton);

    await waitFor(() => {
      expect(callPluginMethod).toHaveBeenCalledWith("token_login");
    });
    expect(window.lvisApi.window.openDetached).not.toHaveBeenCalled();
  });
});

describe("PluginConfigSchemaForm — values prop sync", () => {
  it("re-syncs draft when values prop changes after mount (regression: outlook.com persistence)", async () => {
    // 회귀 가드. PluginConfigTab 의 savedConfig fetch 가 async 라
    // PluginConfigSchemaForm 은 처음에 빈 values 로 마운트된다. 이후
    // savedConfig 가 도착해 values 가 바뀌어도 useState lazy-init 이라
    // draft 가 그대로 비어 있어 사용자에게는 "저장한 값이 사라진" 것처럼
    // 보였다. useEffect([values]) 로 동기화해서 막는다.
    const schema = {
      properties: {
        meetingDetectorAllowedSenderDomains: {
          type: "array" as const,
          title: "허용 도메인",
          items: { type: "string" as const },
        },
      },
    };

    const { rerender } = render(
      <PluginConfigSchemaForm
        pluginId="work-assistant"
        schema={schema}
        values={{}}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );
    const input = document.querySelector(
      '[id="pcfg:work-assistant:meetingDetectorAllowedSenderDomains"]',
    ) as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");

    rerender(
      <PluginConfigSchemaForm
        pluginId="work-assistant"
        schema={schema}
        values={{ meetingDetectorAllowedSenderDomains: ["outlook.com"] }}
        secretsPresent={{}}
        onSave={async () => {}}
        onSetSecret={async () => {}}
      />,
    );

    await waitFor(() => {
      expect(input.value).toBe("outlook.com");
    });
  });
});
