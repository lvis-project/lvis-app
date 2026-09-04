import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { SubscriptionRuntimeCapabilities } from "../../../../shared/subscription-runtime.js";
import {
  SubscriptionAuthControls,
  type SubscriptionProviderView,
} from "../SubscriptionProvidersSection.js";

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
  },
  status: {
    runtime: "ready",
    connection: "connected",
    models: [
      { id: "gpt-5.6-codex", label: "GPT-5.6 Codex", isDefault: true },
      { id: "gpt-5.4-mini", label: "GPT-5.4 mini" },
    ],
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


/**
 * The settings page draws the provider row itself — header, badges, state word,
 * sub-line and refresh — so what ships from this module is the sign-in half,
 * and that is what these tests drive.
 */
function SubscriptionProvidersSection({
  providers,
  actions,
}: {
  providers: readonly SubscriptionProviderView[];
  actions: Parameters<typeof SubscriptionAuthControls>[0]["actions"];
}) {
  return (
    <div>
      {providers.map((provider) => (
        <SubscriptionAuthControls
          key={provider.descriptor.id}
          provider={provider}
          actions={actions}
        />
      ))}
    </div>
  );
}

describe("SubscriptionAuthControls", () => {
  it("carries nothing but sign-in: no header, no state word, no refresh, no model controls", () => {
    render(
      <SubscriptionProvidersSection
        providers={[connectedCodex()]}
        actions={{ refreshStatus: vi.fn(), useForChat: vi.fn(), logout: vi.fn() }}
      />,
    );

    // Every one of these belongs to the row the settings page draws, and having
    // it here too is what gave one provider two headers, two state words and
    // two refresh buttons — each computing its own answer.
    for (const testId of [
      "subscription-provider:codex:refresh",
      "subscription-provider:codex:connection",
      "subscription-provider:codex:capabilities",
      "subscription-provider:codex:capability:chat",
      "subscription-provider:codex:load-models",
      "subscription-provider:codex:model-select",
      "subscription-provider:codex:use-for-chat",
      "subscription-provider:codex:active-selection",
    ]) {
      expect(screen.queryByTestId(testId)).toBeNull();
    }
    // ...and what it does carry is the half with no API-key counterpart.
    expect(screen.getByTestId("subscription-provider:codex:logout")).toBeInTheDocument();
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
        actions={{}}
      />,
    );

    expect(screen.queryByTestId("subscription-provider:codex:device-code")).toBeNull();
    expect(document.body).not.toHaveTextContent("https://auth.example.test/secret-token");
  });
});
