import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type {
  CodexSubscriptionActionResult,
  CodexSubscriptionDeviceCodeResult,
  CodexSubscriptionModelsResult,
  CodexSubscriptionStatus,
} from "../../../../shared/codex-subscription.js";
import type { LvisApi } from "../../types.js";
import { CodexSubscriptionCard } from "../CodexSubscriptionCard.js";

const signedOutStatus = (): CodexSubscriptionStatus => ({
  runtime: "ready",
  connection: "signed-out",
  planType: null,
  pendingLogin: null,
  pendingDeviceCode: null,
});

const browserPendingStatus = (): CodexSubscriptionStatus => ({
  runtime: "ready",
  connection: "pending",
  planType: null,
  pendingLogin: "browser",
  pendingDeviceCode: null,
});

const devicePendingStatus = (pendingDeviceCode = "ABCD-1234"): CodexSubscriptionStatus => ({
  runtime: "ready",
  connection: "pending",
  planType: null,
  pendingLogin: "device-code",
  pendingDeviceCode,
});

const connectedStatus = (): CodexSubscriptionStatus => ({
  runtime: "ready",
  connection: "connected",
  planType: "Plus",
  pendingLogin: null,
  pendingDeviceCode: null,
});

function successfulAction(status: CodexSubscriptionStatus): CodexSubscriptionActionResult {
  return { ok: true, status };
}

type CodexSubscriptionApi = Pick<
  LvisApi,
  | "codexSubscriptionStatus"
  | "codexSubscriptionStartBrowserLogin"
  | "codexSubscriptionStartDeviceCodeLogin"
  | "codexSubscriptionCancelLogin"
  | "codexSubscriptionLogout"
  | "codexSubscriptionListModels"
>;

function makeApi(overrides: Partial<CodexSubscriptionApi> = {}): LvisApi {
  const api: CodexSubscriptionApi = {
    codexSubscriptionStatus: vi.fn(async () => successfulAction(signedOutStatus())),
    codexSubscriptionStartBrowserLogin: vi.fn(async () => successfulAction(browserPendingStatus())),
    codexSubscriptionStartDeviceCodeLogin: vi.fn(async (): Promise<CodexSubscriptionDeviceCodeResult> => ({
      ok: true,
      status: devicePendingStatus(),
      userCode: "ABCD-1234",
    })),
    codexSubscriptionCancelLogin: vi.fn(async () => successfulAction(signedOutStatus())),
    codexSubscriptionLogout: vi.fn(async () => successfulAction(signedOutStatus())),
    codexSubscriptionListModels: vi.fn(async (): Promise<CodexSubscriptionModelsResult> => ({
      ok: true,
      status: connectedStatus(),
      models: [],
    })),
    ...overrides,
  };
  return api as unknown as LvisApi;
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
});

describe("CodexSubscriptionCard", () => {
  it("never renders a browser auth URL returned outside the subscription contract", async () => {
    const authUrl = "https://auth.openai.com/authorize?code=one-time-secret";
    const api = makeApi({
      codexSubscriptionStartBrowserLogin: vi.fn(async () => ({
        ...successfulAction(browserPendingStatus()),
        authUrl,
      }) as unknown as CodexSubscriptionActionResult),
    });

    render(<CodexSubscriptionCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in in browser" }));

    expect(await screen.findByText("Browser sign-in pending")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(authUrl);
  });

  it("moves a browser sign-in into pending state and cancels it", async () => {
    const cancelLogin = vi.fn(async () => successfulAction(signedOutStatus()));
    const api = makeApi({ codexSubscriptionCancelLogin: cancelLogin });

    render(<CodexSubscriptionCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in in browser" }));
    expect(await screen.findByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(cancelLogin).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in in browser" })).toBeInTheDocument();
  });

  it("shows only the one-time device code while device-code sign-in is pending", async () => {
    const api = makeApi({
      codexSubscriptionStartDeviceCodeLogin: vi.fn(async (): Promise<CodexSubscriptionDeviceCodeResult> => ({
        ok: true,
        status: devicePendingStatus("Q7KD-9P2M"),
        userCode: "Q7KD-9P2M",
      })),
    });

    render(<CodexSubscriptionCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Use device code" }));

    expect(await screen.findByTestId("codex-subscription-device-code")).toHaveTextContent("Q7KD-9P2M");
    expect(screen.getByText("Device-code sign-in pending")).toBeInTheDocument();
  });
  it("restores a pending device code from main-owned status", async () => {
    const api = makeApi({
      codexSubscriptionStatus: vi.fn(async () => successfulAction(
        devicePendingStatus("RESTORE-1234"),
      )),
    });

    render(<CodexSubscriptionCard api={api} />);

    expect(await screen.findByTestId("codex-subscription-device-code")).toHaveTextContent("RESTORE-1234");
  });

  it("discovers and renders available models for a connected subscription", async () => {
    const listModels = vi.fn(async (): Promise<CodexSubscriptionModelsResult> => ({
      ok: true,
      status: connectedStatus(),
      models: [
        {
          id: "gpt-5.6-codex",
          displayName: "GPT-5.6 Codex",
          isDefault: true,
          inputModalities: ["text"],
        },
        {
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4 mini",
          isDefault: false,
          inputModalities: ["text", "image"],
        },
      ],
    }));
    const api = makeApi({
      codexSubscriptionStatus: vi.fn(async () => successfulAction(connectedStatus())),
      codexSubscriptionListModels: listModels,
    });

    render(<CodexSubscriptionCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Discover models" }));

    await waitFor(() => expect(listModels).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("GPT-5.6 Codex")).toBeInTheDocument();
    expect(screen.getByText("GPT-5.4 mini")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("maps a stable subscription error code to friendly user-facing text", async () => {
    const unavailableStatus: CodexSubscriptionStatus = {
      runtime: "unavailable",
      connection: "signed-out",
      planType: null,
      pendingLogin: null,
      pendingDeviceCode: null,
    };
    const api = makeApi({
      codexSubscriptionStartBrowserLogin: vi.fn(async (): Promise<CodexSubscriptionActionResult> => ({
        ok: false,
        error: "codex-runtime-unavailable",
        status: unavailableStatus,
      })),
    });

    render(<CodexSubscriptionCard api={api} />);

    fireEvent.click(await screen.findByRole("button", { name: "Sign in in browser" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The bundled Codex runtime is unavailable.");
    expect(alert).not.toHaveTextContent("codex-runtime-unavailable");
  });
});
