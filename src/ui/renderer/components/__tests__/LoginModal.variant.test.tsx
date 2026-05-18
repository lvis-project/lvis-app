// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { LoginModal } from "../LoginModal.js";
import type { LoginPrefs } from "../../types.js";

/**
 * Tutorial-A — LoginModal variant wrapper tests.
 *
 * Verifies:
 *   - The wrapper reads the persisted variant via `loginPrefsGet` on
 *     mount and renders the matching variant component.
 *   - The wrapper subscribes to `onLoginPrefsChanged` so a flip from
 *     Settings re-renders without an app restart.
 *   - The wrapper falls back to the default ("conversational") when
 *     `loginPrefsGet` rejects (read-never-throws contract).
 */

interface ApiOptions {
  initial?: LoginPrefs | null;
  getRejects?: boolean;
}

function makeApi(opts: ApiOptions = {}) {
  const { initial = { loginVariant: "conversational" }, getRejects = false } = opts;
  let changedHandler: ((prefs: LoginPrefs) => void) | null = null;
  return {
    api: {
      loginMockup: vi.fn(async () => ({
        ok: true,
        vendor: "openai",
        fieldsApplied: ["apiKey"],
      })),
      loginPrefsGet: vi.fn(async () => {
        if (getRejects) {
          throw new Error("IPC failed");
        }
        if (initial === null) {
          return {
            ok: false as const,
            error: "missing",
            message: "missing",
          };
        }
        return { ok: true as const, prefs: initial };
      }),
      loginPrefsSet: vi.fn(),
      onLoginPrefsChanged: vi.fn((handler: (prefs: LoginPrefs) => void) => {
        changedHandler = handler;
        return () => {
          changedHandler = null;
        };
      }),
    },
    fireChanged(next: LoginPrefs) {
      changedHandler?.(next);
    },
  };
}

describe("LoginModal wrapper — variant selection (Tutorial-A)", () => {
  it("renders the conversational variant by default", async () => {
    const { api } = makeApi({ initial: { loginVariant: "conversational" } });
    render(
      <LoginModal
        api={api as unknown as Parameters<typeof LoginModal>[0]["api"]}
        open
        onOpenChange={() => {}}
      />,
    );
    await waitFor(() => {
      const modal = document.querySelector('[data-testid="login-modal"]');
      expect(modal?.getAttribute("data-variant")).toBe("conversational");
    });
  });

  it("renders the cli-agent variant when persisted", async () => {
    const { api } = makeApi({ initial: { loginVariant: "cli-agent" } });
    render(
      <LoginModal
        api={api as unknown as Parameters<typeof LoginModal>[0]["api"]}
        open
        onOpenChange={() => {}}
      />,
    );
    await waitFor(() => {
      const modal = document.querySelector('[data-testid="login-modal"]');
      expect(modal?.getAttribute("data-variant")).toBe("cli-agent");
    });
  });

  it("remounts the variant when onLoginPrefsChanged fires", async () => {
    const harness = makeApi({ initial: { loginVariant: "conversational" } });
    render(
      <LoginModal
        api={harness.api as unknown as Parameters<typeof LoginModal>[0]["api"]}
        open
        onOpenChange={() => {}}
      />,
    );
    await waitFor(() => {
      const modal = document.querySelector('[data-testid="login-modal"]');
      expect(modal?.getAttribute("data-variant")).toBe("conversational");
    });

    await act(async () => {
      harness.fireChanged({ loginVariant: "cli-agent" });
    });

    await waitFor(() => {
      const modal = document.querySelector('[data-testid="login-modal"]');
      expect(modal?.getAttribute("data-variant")).toBe("cli-agent");
    });
  });

  it("falls back to conversational when loginPrefsGet rejects", async () => {
    const { api } = makeApi({ getRejects: true });
    render(
      <LoginModal
        api={api as unknown as Parameters<typeof LoginModal>[0]["api"]}
        open
        onOpenChange={() => {}}
      />,
    );
    await waitFor(() => {
      const modal = document.querySelector('[data-testid="login-modal"]');
      expect(modal?.getAttribute("data-variant")).toBe("conversational");
    });
  });
});
