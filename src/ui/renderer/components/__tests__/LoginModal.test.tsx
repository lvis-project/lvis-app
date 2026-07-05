// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, fireEvent, waitFor } from "@testing-library/react";
import { LoginModal } from "../LoginModal.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

/**
 * LoginModal — IPC failure / error mapping tests.
 *
 * Demo activation flow (2026-05-19): the conversational variant funnels
 * chip 1 through an **activation-input sub-state** before the auth step.
 * The user pastes a `LVIS-DEMO:v1:<...>` activation string, the renderer
 * invokes `api.demo.activate(code)`. First activation shows the 5s relaunch
 * notice instead of starting auth; once `.env.demo` is loaded at boot,
 * chip 1 reads `api.demo.status()` and chains into
 * `api.loginMockup({ username: "demo", password: "demo123" })` — no extra
 * user keystroke required. These tests exercise both branches.
 */

function loginModalApi(
  loginImpl: () => Promise<
    | { ok: true; vendor: string; fieldsApplied: string[] }
    | { ok: false; error: string }
  >,
  activateImpl?: () => Promise<
    | { ok: true; vendor: string; requiresRelaunch?: boolean }
    | { ok: false; error: string }
  >,
  relaunchImpl?: () => Promise<
    | { ok: true }
    | { ok: false; error: string }
  >,
  statusImpl?: () => Promise<
    | {
        ok: true;
        activated: boolean;
        vendor: string | null;
        autoActivatable: boolean;
        ollamaAvailable?: boolean;
      }
    | { ok: false; error: string }
  >,
  activateEmbeddedImpl?: () => Promise<
    | { ok: true; vendor: string; requiresRelaunch?: boolean }
    | { ok: false; error: string }
  >,
  activateOllamaImpl?: () => Promise<
    | { ok: true; vendor: "ollama" }
    | { ok: false; error: string }
  >,
) {
  const { api } = makeMockLvisApi();
  Object.assign(api, {
    loginMockup: vi.fn(loginImpl),
    openSettingsWindow: vi.fn(),
    demo: {
      status: vi.fn(
        statusImpl ??
          (async () => ({
            ok: true,
            activated: false,
            vendor: null,
            autoActivatable: false,
            ollamaAvailable: false,
          })),
      ),
      activate: vi.fn(
        activateImpl ?? (async () => ({ ok: true, vendor: "azure-foundry" })),
      ),
      activateEmbedded: vi.fn(
        activateEmbeddedImpl ??
          (async () => ({ ok: false, error: "no-embedded-code" })),
      ),
      activateOllama: vi.fn(
        activateOllamaImpl ?? (async () => ({ ok: true, vendor: "ollama" as const })),
      ),
      relaunchAfterActivation: vi.fn(
        relaunchImpl ?? (async () => ({ ok: true })),
      ),
    },
  });
  return api as unknown as Parameters<typeof LoginModal>[0]["api"];
}

// The activation string is opaque to the renderer — the IPC mock controls
// the resolve value. Any non-empty string passes the renderer's pre-flight
// "trim().length === 0" guard.
const FAKE_ACTIVATION_CODE = "LVIS-DEMO:v1:test-fake-payload";

describe("LoginModal — chip-driven demo flow (activation → auth)", () => {
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleError = console.error;
    // suppress the expected console.error during the rejection test
    console.error = vi.fn();
    delete (window as unknown as { lvis?: unknown }).lvis;
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  function clickDemoChip() {
    const chip = document.querySelector('[data-testid="login-modal:chip-demo"]') as HTMLButtonElement;
    expect(chip).toBeTruthy();
    fireEvent.click(chip);
  }

  async function completeActivation() {
    // Wait for the activation textarea to mount after chip 1 click.
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="login-modal:activation-code-input"]',
        ),
      ).toBeTruthy();
    });
    const textarea = document.querySelector(
      '[data-testid="login-modal:activation-code-input"]',
    ) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(textarea);
    fireEvent.change(textarea, { target: { value: FAKE_ACTIVATION_CODE } });
    const submit = document.querySelector(
      '[data-testid="login-modal:activation-submit"]',
    ) as HTMLButtonElement;
    fireEvent.click(submit);
    // Auto-advance when no relaunch is required: activation success chains
    // straight into the auth transcript via `runAuthMockup()` — no explicit
    // Enter click required. The `waitFor(loginMockup)` in the caller paces
    // the test around the IPC roundtrip.
  }

  it("fires loginMockup with hard-coded demo credentials after activation", async () => {
    const api = loginModalApi(async () => ({
      ok: true,
      vendor: "azure-foundry",
      fieldsApplied: ["apiKey"],
    }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    // Wait for the modal to mount.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();
    await completeActivation();

    await waitFor(() => {
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).toHaveBeenCalledWith({ username: "demo", password: "demo123" });
    });
    // demo.activate was also called with the pasted code.
    expect(
      (api as unknown as { demo: { activate: ReturnType<typeof vi.fn> } }).demo
        .activate,
    ).toHaveBeenCalledWith(FAKE_ACTIVATION_CODE);
  });

  it("skips activation input and runs loginMockup when demo env was loaded at boot", async () => {
    const api = loginModalApi(
      async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey", "baseUrl"],
      }),
      undefined,
      undefined,
      async () => ({ ok: true, activated: true, vendor: "azure-foundry", autoActivatable: false }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).toHaveBeenCalledWith({ username: "demo", password: "demo123" });
    });
    expect(
      document.querySelector('[data-testid="login-modal:activation-code-input"]'),
    ).toBeNull();
    expect(
      (api as unknown as { demo: { activate: ReturnType<typeof vi.fn> } }).demo
        .activate,
    ).not.toHaveBeenCalled();
    // #1498 — `demo.status()` is now called twice: once by the on-open
    // Ollama availability probe (independent of any chip click), and once
    // by the chip-1 click handler's own status check.
    expect(
      (api as unknown as { demo: { status: ReturnType<typeof vi.fn> } }).demo
        .status,
    ).toHaveBeenCalledTimes(2);
  });

  it("forceActivation opens the activation input even when demo status is already active", async () => {
    const api = loginModalApi(
      async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey", "baseUrl"],
      }),
      undefined,
      undefined,
      async () => ({ ok: true, activated: true, vendor: "azure-foundry", autoActivatable: false }),
    );
    render(
      <LoginModal
        api={api}
        open
        forceActivation
        onOpenChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="login-modal:activation-code-input"]',
        ),
      ).toBeTruthy();
    });
    expect(
      (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
    ).not.toHaveBeenCalled();
    expect(
      (api as unknown as { demo: { activate: ReturnType<typeof vi.fn> } }).demo
        .activate,
    ).not.toHaveBeenCalled();
    // #1498 — the on-open Ollama probe fires alongside forceActivation's
    // own auto-triggered chip-1 status check, so status() is called twice.
    expect(
      (api as unknown as { demo: { status: ReturnType<typeof vi.fn> } }).demo
        .status,
    ).toHaveBeenCalledTimes(2);
  });

  it("displays a Korean error message when the auth IPC call rejects", async () => {
    const api = loginModalApi(async () => {
      throw new Error("IPC channel disconnected");
    });
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();
    await completeActivation();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("로그인 처리 중 오류가 발생했습니다.");
    });
  });

  it("shows the mapped Korean error for invalid-credentials", async () => {
    const api = loginModalApi(async () => ({ ok: false, error: "invalid-credentials" }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();
    await completeActivation();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("활성화 키가 승인되지 않았습니다.");
    });
  });

  it("shows the mapped Korean error for no-demo-key", async () => {
    const api = loginModalApi(async () => ({ ok: false, error: "no-demo-key" }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();
    await completeActivation();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      // Enterprise activation copy must NOT expose internal env var names —
      // it points the user at their administrator instead.
      expect(err?.textContent).toMatch(/활성화가 아직 설정되지 않았습니다/);
      expect(err?.textContent).not.toMatch(/LVIS_DEMO_VENDOR/);
    });
  });

  it("does not render the legacy username/password form in the conversational variant", async () => {
    const api = loginModalApi(async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });

    expect(document.querySelector('[data-testid="login-modal:username"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:password"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:submit"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal:form"]')).toBeNull();
  });

  it("keeps demo activation inside the chat transcript instead of a dedicated page", async () => {
    const api = loginModalApi(async () => ({
      ok: true,
      vendor: "azure-foundry",
      fieldsApplied: ["apiKey"],
    }));
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:user-turn"]')).toBeTruthy();
      expect(document.querySelector('[data-testid="login-modal:assistant-reply"]')).toBeTruthy();
      expect(
        document.querySelector('[data-testid="login-modal:activation-code-input"]'),
      ).toBeTruthy();
    });
    expect(document.querySelector('[data-page="activation"]')).toBeNull();
    expect(document.querySelector('[data-testid="login-modal"]')).toBeTruthy();
  });

  it("does not reveal the auth checklist before the activation code is submitted", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    try {
      const api = loginModalApi(async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey"],
      }));
      render(<LoginModal api={api} open onOpenChange={() => {}} />);

      clickDemoChip();
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });

      expect(
        document.querySelector('[data-testid="login-modal:activation-code-input"]'),
      ).toBeTruthy();
      expect(
        document.querySelector('[data-testid="login-modal:auth-checklist"]'),
      ).toBeNull();
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a Korean activation error when demo.activate rejects with invalid-code", async () => {
    const api = loginModalApi(
      async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
      async () => ({ ok: false, error: "invalid-code" }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();
    await waitFor(() => {
      expect(
        document.querySelector(
          '[data-testid="login-modal:activation-code-input"]',
        ),
      ).toBeTruthy();
    });
    const textarea = document.querySelector(
      '[data-testid="login-modal:activation-code-input"]',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "bad-code" } });
    const submit = document.querySelector(
      '[data-testid="login-modal:activation-submit"]',
    ) as HTMLButtonElement;
    fireEvent.click(submit);

    await waitFor(() => {
      const err = document.querySelector(
        '[data-testid="login-modal:activation-error"]',
      );
      expect(err?.textContent).toMatch(/활성화 키가 올바르지 않아요/);
    });
    // Auth step MUST NOT fire when activation fails.
    expect(
      (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
    ).not.toHaveBeenCalled();
  });

  it("shows the 5s relaunch notice and then requests armed relaunch", async () => {
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ["setTimeout", "clearTimeout", "Date"],
    });
    try {
      const api = loginModalApi(
        async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
        async () => ({ ok: true, vendor: "azure-foundry", requiresRelaunch: true }),
        async () => ({ ok: true }),
      );
      render(<LoginModal api={api} open onOpenChange={() => {}} />);

      await waitFor(() => {
        expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
      });
      clickDemoChip();
      await waitFor(() => {
        expect(
          document.querySelector(
            '[data-testid="login-modal:activation-code-input"]',
          ),
        ).toBeTruthy();
      });
      const textarea = document.querySelector(
        '[data-testid="login-modal:activation-code-input"]',
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: FAKE_ACTIVATION_CODE } });
      const submit = document.querySelector(
        '[data-testid="login-modal:activation-submit"]',
      ) as HTMLButtonElement;
      fireEvent.click(submit);

      await waitFor(() => {
        const notice = document.querySelector(
          '[data-testid="login-modal:activation-notice"]',
        );
        expect(notice?.textContent).toContain("활성화 적용을 위해 5초 후 자동으로 다시 시작합니다");
      });
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).not.toHaveBeenCalled();
      expect(
        (api as unknown as { demo: { relaunchAfterActivation: ReturnType<typeof vi.fn> } }).demo
          .relaunchAfterActivation,
      ).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(5000);
      });

      await waitFor(() => {
        expect(
          (api as unknown as { demo: { relaunchAfterActivation: ReturnType<typeof vi.fn> } }).demo
            .relaunchAfterActivation,
        ).toHaveBeenCalledOnce();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-activates with the embedded key and never mounts the paste input", async () => {
    const api = loginModalApi(
      async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey"],
      }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: true,
      }),
      async () => ({ ok: true, vendor: "azure-foundry" }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    await waitFor(() => {
      expect(
        (api as unknown as { demo: { activateEmbedded: ReturnType<typeof vi.fn> } }).demo
          .activateEmbedded,
      ).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(
        (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
      ).toHaveBeenCalledWith({ username: "demo", password: "demo123" });
    });
    // The manual paste input never mounted and the paste IPC never fired.
    expect(
      document.querySelector('[data-testid="login-modal:activation-code-input"]'),
    ).toBeNull();
    expect(
      (api as unknown as { demo: { activate: ReturnType<typeof vi.fn> } }).demo
        .activate,
    ).not.toHaveBeenCalled();
  });

  it("falls back to the paste input with an error when the embedded key is rejected", async () => {
    const api = loginModalApi(
      async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey"],
      }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: true,
      }),
      async () => ({ ok: false, error: "invalid-code" }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    clickDemoChip();

    // The stale embedded key surfaces its activation error AND the manual
    // input so the user can still paste a fresh key.
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="login-modal:activation-code-input"]'),
      ).toBeTruthy();
    });
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="login-modal:activation-error"]'),
      ).toBeTruthy();
    });
    expect(
      (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
    ).not.toHaveBeenCalled();
  });

  it("forceActivation keeps the manual input even when the build embeds a key", async () => {
    const api = loginModalApi(
      async () => ({
        ok: true,
        vendor: "azure-foundry",
        fieldsApplied: ["apiKey"],
      }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: true,
        vendor: "azure-foundry",
        autoActivatable: true,
      }),
    );
    render(
      <LoginModal
        api={api}
        open
        forceActivation
        onOpenChange={() => {}}
      />,
    );

    // Settings 재입력 recovery must let the user paste a *different* key
    // than the embedded one — the embedded path must not hijack it.
    await waitFor(() => {
      expect(
        document.querySelector('[data-testid="login-modal:activation-code-input"]'),
      ).toBeTruthy();
    });
    expect(
      (api as unknown as { demo: { activateEmbedded: ReturnType<typeof vi.fn> } }).demo
        .activateEmbedded,
    ).not.toHaveBeenCalled();
  });
});

describe("LoginModal — Ollama local-model chip (#1498)", () => {
  beforeEach(() => {
    delete (window as unknown as { lvis?: unknown }).lvis;
  });

  it("does not render the Ollama chip when the probe finds no local server", async () => {
    const api = loginModalApi(
      async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: false,
        ollamaAvailable: false,
      }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-demo"]')).toBeTruthy();
    });
    expect(document.querySelector('[data-testid="login-modal:chip-ollama"]')).toBeNull();
  });

  it("renders the Ollama chip when the probe finds a local server", async () => {
    const api = loginModalApi(
      async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: false,
        ollamaAvailable: true,
      }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-ollama"]')).toBeTruthy();
    });
  });

  it("clicking the Ollama chip calls activateOllama and hands off via onSuccess", async () => {
    const onSuccess = vi.fn();
    const onOpenChange = vi.fn();
    const api = loginModalApi(
      async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: false,
        ollamaAvailable: true,
      }),
      undefined,
      async () => ({ ok: true, vendor: "ollama" }),
    );
    render(
      <LoginModal api={api} open onOpenChange={onOpenChange} onSuccess={onSuccess} />,
    );

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-ollama"]')).toBeTruthy();
    });
    fireEvent.click(
      document.querySelector('[data-testid="login-modal:chip-ollama"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      expect(
        (api as unknown as { demo: { activateOllama: ReturnType<typeof vi.fn> } }).demo
          .activateOllama,
      ).toHaveBeenCalledOnce();
    });
    await waitFor(() => {
      expect(onSuccess).toHaveBeenCalledWith(
        "ollama",
        expect.objectContaining({ ok: true, vendor: "ollama" }),
      );
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    // The demo credential flow must not fire for the Ollama path.
    expect(
      (api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup,
    ).not.toHaveBeenCalled();
  });

  it("shows a Korean error and keeps the modal open when the server disappeared", async () => {
    const onSuccess = vi.fn();
    const api = loginModalApi(
      async () => ({ ok: true, vendor: "azure-foundry", fieldsApplied: ["apiKey"] }),
      undefined,
      undefined,
      async () => ({
        ok: true,
        activated: false,
        vendor: null,
        autoActivatable: false,
        ollamaAvailable: true,
      }),
      undefined,
      async () => ({ ok: false, error: "no-ollama" }),
    );
    render(<LoginModal api={api} open onOpenChange={() => {}} onSuccess={onSuccess} />);

    await waitFor(() => {
      expect(document.querySelector('[data-testid="login-modal:chip-ollama"]')).toBeTruthy();
    });
    fireEvent.click(
      document.querySelector('[data-testid="login-modal:chip-ollama"]') as HTMLButtonElement,
    );

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toMatch(/로컬 Ollama 서버를 찾을 수 없어요/);
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
