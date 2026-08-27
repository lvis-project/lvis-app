import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { SubscriptionRuntimeCapabilities } from "../../../../shared/subscription-runtime.js";
import {
  ProviderCapabilityGrid,
  SubscriptionProvidersSection,
  type SubscriptionProviderView,
} from "../SubscriptionProvidersSection.js";
import {
  API_PATH_RUNTIME_CAPABILITIES,
  DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES,
} from "../../../../shared/subscription-runtime.js";

function runtimeCapabilities(
  overrides: Partial<SubscriptionRuntimeCapabilities> = {},
): SubscriptionRuntimeCapabilities {
  return {
    chat: true,
    images: true,
    imageAttachmentLimits: {
      maxCount: 5,
      maxBytesPerImage: 25 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
    },
    files: true,
    tools: true,
    projectAccess: true,
    plugins: true,
    mcp: true,
    generateText: true,
    compaction: true,
    routine: true,
    subagent: true,
    ...overrides,
  };
}

const connectedCodex = (overrides: Partial<SubscriptionProviderView> = {}): SubscriptionProviderView => ({
  descriptor: {
    id: "codex",
    label: "Codex",
    description: "Use your existing ChatGPT subscription.",
    loginMethods: ["browser", "device-code"],
    supportsLogout: true,
    modelSelection: "required",
  },
  status: {
    runtime: "ready",
    connection: "connected",
    models: [
      { id: "gpt-5.6-codex", label: "GPT-5.6 Codex", isDefault: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    ],
    selectedModelId: "gpt-5.6-codex",
    capabilities: runtimeCapabilities(),
  },
  ...overrides,
});

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("SubscriptionProvidersSection", () => {
  it("shows only host-verified runtime capabilities as available", () => {
    render(
      <SubscriptionProvidersSection
        providers={[connectedCodex()]}
        activeSelection={{ providerId: "codex", modelId: "gpt-5.6-codex" }}
        actions={{}}
      />,
    );

    expect(screen.getByTestId("subscription-provider:codex:active-selection")).toBeInTheDocument();
    for (const capability of [
      "chat",
      "images",
      "files",
      "tools",
      "projectAccess",
      "plugins",
      "mcp",
      "generateText",
      "compaction",
      "routine",
      "subagent",
    ]) {
      expect(screen.getByTestId(`subscription-provider:codex:capability:${capability}`))
        .toHaveTextContent("Available");
    }
  });

  it("never claims a missing capability projection is available", () => {
    const provider = connectedCodex();
    const status = provider.status!;
    render(
      <SubscriptionProvidersSection
        providers={[{ ...provider, status: { ...status, capabilities: undefined } }]}
        activeSelection={null}
        actions={{ useForChat: vi.fn() }}
      />,
    );

    expect(screen.getByTestId("subscription-provider:codex:capability:chat"))
      .toHaveTextContent("Not verified yet");
    expect(screen.getByTestId("subscription-provider:codex:capability:tools"))
      .toHaveTextContent("Not verified yet");
    expect(screen.getByTestId("subscription-provider:codex:use-for-chat")).toBeDisabled();
  });

  it("does not render an empty provider description paragraph", () => {
    const provider = connectedCodex();
    render(
      <SubscriptionProvidersSection
        providers={[{ ...provider, descriptor: { ...provider.descriptor, description: "" } }]}
        activeSelection={null}
        actions={{}}
      />,
    );

    expect(screen.getByTestId("subscription-provider:codex").querySelector(".min-w-0 > p")).toBeNull();
  });

  it("sends the selected provider and model through the common selection callbacks", async () => {
    const selectModel = vi.fn();
    const useForChat = vi.fn();
    render(
      <SubscriptionProvidersSection
        providers={[connectedCodex()]}
        activeSelection={null}
        actions={{ selectModel, useForChat }}
      />,
    );

    fireEvent.click(screen.getByTestId("subscription-provider:codex:model-select"));
    fireEvent.click(await screen.findByRole("option", { name: /GPT-5\.4 mini/ }));
    await waitFor(() => expect(selectModel).toHaveBeenCalledWith("codex", "gpt-5.4-mini"));

    fireEvent.click(screen.getByTestId("subscription-provider:codex:use-for-chat"));
    await waitFor(() => expect(useForChat).toHaveBeenCalledWith("codex", "gpt-5.6-codex"));
  });

  it("supports common browser/device login, pending browser opening, cancellation, and logout actions", async () => {
    const beginLogin = vi.fn();
    const openLoginBrowser = vi.fn();
    const cancelLogin = vi.fn();
    const logout = vi.fn();
    const { rerender } = render(
      <SubscriptionProvidersSection
        providers={[{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "signed-out",
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }]}
        activeSelection={null}
        actions={{ beginLogin, openLoginBrowser, cancelLogin, logout }}
      />,
    );

    fireEvent.click(screen.getByTestId("subscription-provider:codex:login-browser"));
    fireEvent.click(screen.getByTestId("subscription-provider:codex:login-device-code"));
    await waitFor(() => {
      expect(beginLogin).toHaveBeenCalledWith("codex", "browser");
      expect(beginLogin).toHaveBeenCalledWith("codex", "device-code");
    });

    rerender(
      <SubscriptionProvidersSection
        providers={[{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "pending",
            pendingLoginMethod: "device-code",
            pendingDeviceCode: "Q7KD-9P2M",
            canOpenLoginBrowser: true,
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }]}
        activeSelection={null}
        actions={{ beginLogin, openLoginBrowser, cancelLogin, logout }}
      />,
    );

    expect(screen.getByTestId("subscription-provider:codex:device-code")).toHaveTextContent("Q7KD-9P2M");
    fireEvent.click(screen.getByTestId("subscription-provider:codex:open-login-browser"));
    fireEvent.click(screen.getByTestId("subscription-provider:codex:cancel-login"));
    await waitFor(() => {
      expect(openLoginBrowser).toHaveBeenCalledWith("codex");
      expect(cancelLogin).toHaveBeenCalledWith("codex");
    });

    rerender(
      <SubscriptionProvidersSection
        providers={[connectedCodex()]}
        activeSelection={null}
        actions={{ logout }}
      />,
    );
    fireEvent.click(screen.getByTestId("subscription-provider:codex:logout"));
    await waitFor(() => expect(logout).toHaveBeenCalledWith("codex"));
  });

  it("never renders URL, token, or raw CLI output fields outside the browser-safe contract", () => {
    const authUrl = "https://auth.example.test/authorize?one-time-secret";
    const token = "secret-access-token";
    const rawCliOutput = "runtime stderr: bearer token=secret-access-token";
    const unsafeProvider = {
      ...connectedCodex(),
      descriptor: {
        ...connectedCodex().descriptor,
        authUrl,
        accessToken: token,
      },
      status: {
        ...connectedCodex().status,
        rawCliOutput,
        verificationUrl: authUrl,
      },
    } as unknown as SubscriptionProviderView;

    render(
      <SubscriptionProvidersSection
        providers={[unsafeProvider]}
        activeSelection={null}
        actions={{}}
      />,
    );

    expect(document.body).not.toHaveTextContent(authUrl);
    expect(document.body).not.toHaveTextContent(token);
    expect(document.body).not.toHaveTextContent(rawCliOutput);
  });

  it("rejects a device code that looks like a URL or bearer token", () => {
    render(
      <SubscriptionProvidersSection
        providers={[{
          ...connectedCodex(),
          status: {
            runtime: "ready",
            connection: "pending",
            pendingLoginMethod: "device-code",
            pendingDeviceCode: "https://auth.example.test/secret-token",
            capabilities: runtimeCapabilities({ chat: false }),
          },
        }]}
        activeSelection={null}
        actions={{}}
      />,
    );

    expect(screen.queryByTestId("subscription-provider:codex:device-code")).toBeNull();
    expect(document.body).not.toHaveTextContent("https://auth.example.test/secret-token");
  });
});

describe("ProviderCapabilityGrid", () => {
  it("answers every checklist row for the API path", () => {
    render(
      <ProviderCapabilityGrid
        capabilities={API_PATH_RUNTIME_CAPABILITIES}
        known={() => true}
        testIdPrefix="api-path"
      />,
    );

    const grid = screen.getByTestId("api-path:capabilities");
    const rows = grid.querySelectorAll("[data-testid^='api-path:capability:']");
    // The API path claims the host engine's features, so no row may read
    // "unavailable" — a new capability key added to the checklist without a
    // matching entry in the projection fails right here.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector("dd")?.textContent).toBe("Available");
    }
  });

  it("reads unknown, not unavailable, for a vendor that has answered nothing", () => {
    render(
      <ProviderCapabilityGrid
        capabilities={DEFAULT_SUBSCRIPTION_RUNTIME_CAPABILITIES}
        known={() => false}
        testIdPrefix="api-path"
      />,
    );

    const chat = screen.getByTestId("api-path:capability:chat");
    expect(chat.querySelector("dd")?.textContent).toBe("Not verified yet");
  });
});
