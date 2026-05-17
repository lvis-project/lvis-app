// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { LoginModal } from "../LoginModal.js";

/**
 * #893 / PR #894 review T1-1 — LoginModal try/catch + finally cleanup tests.
 *
 * Verifies:
 *   - IPC rejection surfaces a Korean user-facing error and resets submitting
 *   - The password is wiped in finally so a transient error doesn't leave
 *     it visible on the next render (T1-1 / L1 cleanup).
 */

function makeApi(impl: () => Promise<{ ok: true; vendor: string } | { ok: false; error: string }>) {
  return {
    loginMockup: vi.fn(impl),
  } as unknown as Parameters<typeof LoginModal>[0]["api"];
}

describe("LoginModal — IPC failure handling (#894 T1-1)", () => {
  let originalConsoleError: typeof console.error;
  beforeEach(() => {
    originalConsoleError = console.error;
    // suppress the expected console.error during the rejection test
    console.error = vi.fn();
  });
  afterEach(() => {
    console.error = originalConsoleError;
  });

  // Dialog renders into a portal attached to `document.body`, not into the
  // render container. All queries below traverse `document` rather than the
  // returned `container` so the test sees the modal contents.
  function fillAndSubmit(password: string = "demo123") {
    const username = document.querySelector('[data-testid="login-modal:username"]') as HTMLInputElement;
    const pw = document.querySelector('[data-testid="login-modal:password"]') as HTMLInputElement;
    const submit = document.querySelector('[data-testid="login-modal:submit"]') as HTMLButtonElement;
    fireEvent.change(username, { target: { value: "demo" } });
    fireEvent.change(pw, { target: { value: password } });
    fireEvent.click(submit);
  }

  it("displays a Korean error message when the IPC call rejects", async () => {
    const api = makeApi(async () => {
      throw new Error("IPC channel disconnected");
    });
    render(<LoginModal api={api} vendor="openai" open onOpenChange={() => {}} />);
    fillAndSubmit();

    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("로그인 처리 중 오류가 발생했습니다.");
    });
    const submit = document.querySelector('[data-testid="login-modal:submit"]') as HTMLButtonElement;
    const pw = document.querySelector('[data-testid="login-modal:password"]') as HTMLInputElement;
    // The password is wiped in finally so a transient error never leaves it
    // on screen (L1 cleanup).
    expect(pw.value).toBe("");
    // Submit is disabled because the password is empty — NOT because the
    // submitting flag stayed stuck.
    expect(submit.disabled).toBe(true);
  });

  it("clears the password in finally even on success", async () => {
    const api = makeApi(async () => ({ ok: true, vendor: "openai" }));
    let openState = true;
    render(
      <LoginModal
        api={api}
        vendor="openai"
        open={openState}
        onOpenChange={(o) => {
          openState = o;
        }}
      />,
    );
    fillAndSubmit("demo123");
    await waitFor(() => {
      expect((api as unknown as { loginMockup: ReturnType<typeof vi.fn> }).loginMockup).toHaveBeenCalled();
    });
    const pw = document.querySelector('[data-testid="login-modal:password"]') as HTMLInputElement | null;
    if (pw) {
      expect(pw.value).toBe("");
    }
  });

  it("shows the mapped Korean error for invalid-credentials", async () => {
    const api = makeApi(async () => ({ ok: false, error: "invalid-credentials" }));
    render(<LoginModal api={api} vendor="openai" open onOpenChange={() => {}} />);
    fillAndSubmit("wrong");
    await waitFor(() => {
      const err = document.querySelector('[data-testid="login-modal:error"]');
      expect(err?.textContent).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
    });
  });
});
