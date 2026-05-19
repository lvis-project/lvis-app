// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { LoginModal } from "../LoginModal.js";

/**
 * LoginModal — IPC failure / error mapping tests.
 *
 * Path 2 hotfix (2026-05-19): the conversational variant is form-less.
 * The demo chip auto-fires `loginMockup({ username: "demo", password:
 * "demo123" })` without ever exposing inputs to the user. These tests
 * exercise the chip-driven flow and confirm the renderer maps kebab-case
 * IPC error codes to Korean user-facing text (CLAUDE.md error-language).
 */

function makeApi(
  impl: () => Promise<
    | { ok: true; vendor: string; fieldsApplied: string[] }
    | { ok: false; error: string }
  >,
) {
  // Tutorial-A — LoginModal is a variant-aware wrapper that calls
  // `loginPrefsGet` on mount. Stub the prefs surface so the wrapper
  // mounts the conversational variant deterministically.
  return {
    loginMockup: vi.fn(impl),
    openSettingsWindow: vi.fn(),
    loginPrefsGet: vi.fn(async () => ({
      ok: true as const,
      prefs: { loginVariant: "conversational" as const },
    })),
    loginPrefsSet: vi.fn(),
    onLoginPrefsChanged: vi.fn(() => () => {}),
  } as unknown as Parameters<typeof LoginModal>[0]["api"];
}

describe("LoginModal — chip-driven demo flow (Path 2 hotfix)", () => {
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleError = console.error;
    // suppress the expected console.error during the rejection test
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  function clickDemoChip() {
    const chip = document.querySelector('[data-testid="login-modal:chip-demo"]') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
  }

  it("fires loginMockup with hard-coded demo credentials on chip click", async () => {
    const api = makeApi(async () => ({
      ok: true,
      vendor: "azure-foundry",
      fieldsApplied: ["apiKey"],
    }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    // Wait for the conversational variant to mount (it does a loginPrefsGet)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).toHaveBeenCalledWith({ username: "demo", password: "demo123" });
    });
  });

  it("displays a Korean error message when the IPC call rejects", async () => {
    const api = makeApi(async () => {
      throw new Error("IPC channel disconnected");
    });
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("로그인 처리 중 오류가 발생했습니다.");
    });
  });

  it("shows the mapped Korean error for invalid-credentials", async () => {
    const api = makeApi(async () => ({ ok: false, error: "invalid-credentials" }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("데모 자격증명이 올바르지 않습니다.");
    });
  });

  it("shows the mapped Korean error for no-demo-key", async () => {
    const api = makeApi(async () => ({ ok: false, error: "no-demo-key" }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toMatch(/데모 API 키가 환경 변수에 설정되어 있지 않습니다/);
    });
  });

  it("does not render the legacy username/password form in the conversational variant", async () => {
    const api = makeApi(async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });

    expect(document.querySelector('[data-testid="login-modal:username"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:password"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:submit"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:form"]')).toBeNull();
  });
});
