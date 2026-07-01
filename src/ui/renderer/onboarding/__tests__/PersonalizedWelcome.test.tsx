// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PersonalizedWelcome } from "../PersonalizedWelcome.js";
import type { AiProviderPingIpcResult } from "../../../../shared/ai-provider-ping.js";

function personalizedWelcomeApi(
  pingImpl: () => Promise<AiProviderPingIpcResult>,
): {
  pingAiProvider: ReturnType<typeof vi.fn>;
} {
  const pingAiProvider = vi.fn(pingImpl);
  return { pingAiProvider };
}

describe("PersonalizedWelcome", () => {
  it("renders nothing when open=false", () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 120,
    }));
    render(
      <PersonalizedWelcome open={false} pingAiProvider={pingAiProvider} onContinue={() => {}} />,
    );
    expect(screen.queryByTestId("personalized-welcome")).toBeNull();
  });

  it("uses neutral greeting when nickname is empty", () => {
    const { pingAiProvider } = personalizedWelcomeApi(
      async () =>
        new Promise(() => {
          // never resolves — stays in loading
        }),
    );
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    expect(
      screen.getByTestId("personalized-welcome:greeting").textContent,
    ).toMatch(/안녕하세요/);
  });

  it("greets the user by 호칭 when nickname is set", () => {
    const { pingAiProvider } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(
      <PersonalizedWelcome
        open
        nickname="Ken"
        pingAiProvider={pingAiProvider}
        onContinue={() => {}}
      />,
    );
    expect(
      screen.getByTestId("personalized-welcome:greeting").textContent,
    ).toMatch(/Ken님/);
  });

  it("reflects the user's intro line as a quoted welcome message", () => {
    const { pingAiProvider } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(
      <PersonalizedWelcome
        open
        nickname="Ken"
        introduction="PM, 회의록 정리"
        pingAiProvider={pingAiProvider}
        onContinue={() => {}}
      />,
    );
    expect(
      screen.getByTestId("personalized-welcome:intro").textContent,
    ).toContain("PM, 회의록 정리");
  });

  it("ping loading: shows spinner row and disables continue button", () => {
    const { pingAiProvider } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    expect(
      screen.getByTestId("personalized-welcome:ping-loading"),
    ).toBeTruthy();
    const cta = screen.getByTestId(
      "personalized-welcome:continue",
    ) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it("ping success: surfaces vendor/model/latency line and enables continue", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 142,
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-success"),
      ).toBeTruthy();
    });
    const success = screen.getByTestId(
      "personalized-welcome:ping-success",
    );
    expect(success.textContent).toContain("azure-foundry");
    expect(success.textContent).toContain("gpt-4");
    expect(success.textContent).toContain("142ms");
    const cta = screen.getByTestId(
      "personalized-welcome:continue",
    ) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
  });

  it("renders first-run readiness inventory for provider, runtime, plugins, marketplace, and Windows", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "openai",
      model: "gpt-5.4-mini",
      latencyMs: 81,
    }));
    render(
      <PersonalizedWelcome
        open
        pingAiProvider={pingAiProvider}
        getRuntimeCounts={async () => ({ tools: 7, plugins: 2, mcps: 1 })}
        getRuntimeEnv={async () => ({ platform: "win32", hostname: "desk", user: "ken" })}
        pluginSummary={{
          installed: 2,
          loaded: 2,
          preparing: 0,
          failed: 0,
          disabled: 0,
          activeTools: 7,
        }}
        marketplaceUrlReady
        onContinue={() => {}}
      />,
    );

    await waitFor(() => {
      const readiness = screen.getByTestId("first-run-readiness");
      expect(readiness.textContent).toContain("openai");
      expect(readiness.textContent).toContain("gpt-5.4-mini");
      expect(readiness.textContent).toContain("도구 7개");
      expect(readiness.textContent).toContain("플러그인 2개");
      expect(readiness.textContent).toContain("활성 도구 7개");
      expect(readiness.textContent).toContain("Marketplace URL");
      expect(readiness.textContent).toContain("Windows 복구 참고");
    });
  });

  it("surfaces a Windows bootstrap repair hint and retries bootstrap on demand", async () => {
    const retryBootstrap = vi.fn();
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "openai",
      model: "gpt-5.4-mini",
      latencyMs: 81,
    }));
    render(
      <PersonalizedWelcome
        open
        pingAiProvider={pingAiProvider}
        getRuntimeCounts={async () => ({ tools: 0, plugins: 1, mcps: 0 })}
        getRuntimeEnv={async () => ({ platform: "win32", hostname: "desk", user: "ken" })}
        pluginSummary={{
          installed: 1,
          loaded: 0,
          preparing: 0,
          failed: 1,
          disabled: 0,
          activeTools: 0,
        }}
        marketplaceUrlReady={false}
        bootstrapStatus={{
          phase: "complete",
          installed: [],
          failed: [{ id: "local-indexer", error: "EPERM: file is locked" }],
        }}
        onRetryBootstrap={retryBootstrap}
        onContinue={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("first-run-readiness").textContent).toContain(
        "Windows 파일 잠금",
      );
    });

    fireEvent.click(screen.getByTestId("first-run-readiness:retry-bootstrap"));
    expect(retryBootstrap).toHaveBeenCalledTimes(1);
  });

  it("ping failure (not-configured): surfaces warning but keeps continue enabled (fallback path)", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: false,
      online: false,
      vendor: "azure-foundry",
      error: "not-configured",
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-failure"),
      ).toBeTruthy();
    });
    const failure = screen.getByTestId(
      "personalized-welcome:ping-failure",
    );
    expect(failure.textContent).toContain("LLM 연결을 확인하지 못했습니다");
    const cta = screen.getByTestId(
      "personalized-welcome:continue",
    ) as HTMLButtonElement;
    expect(cta.disabled).toBe(false);
  });

  it("ping failure (private endpoint): points the user at VPN or network connection", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: false,
      vendor: "azure-foundry",
      model: "gpt-5.4-mini",
      error: "Public access is disabled. Please configure private endpoint.",
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-failure"),
      ).toBeTruthy();
    });
    const failure = screen.getByTestId(
      "personalized-welcome:ping-failure",
    );
    expect(failure.textContent).toContain("VPN");
    expect(failure.textContent).toContain("네트워크 연결");
  });

  it("ping failure (timeout): points the user at VPN or network connection", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: false,
      vendor: "azure-foundry",
      model: "gpt-5.4-mini",
      error: "timeout",
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-failure"),
      ).toBeTruthy();
    });
    const failure = screen.getByTestId(
      "personalized-welcome:ping-failure",
    );
    expect(failure.textContent).toContain("VPN");
    expect(failure.textContent).toContain("네트워크 연결");
  });

  it("ping failure (unauthorized-frame ok=false): surfaces warning + keeps continue enabled", async () => {
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      ok: false,
      error: "unauthorized-frame",
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-failure"),
      ).toBeTruthy();
    });
  });

  it("'예, 시작할게요 →' fires onContinue once ping resolves", async () => {
    const onContinue = vi.fn();
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 90,
    }));
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={onContinue} />);
    await waitFor(() => {
      expect(
        (screen.getByTestId("personalized-welcome:continue") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    fireEvent.click(screen.getByTestId("personalized-welcome:continue"));
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it("does NOT expose a skip button (forced choice)", () => {
    const { pingAiProvider } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
    expect(screen.queryByTestId("personalized-welcome:skip")).toBeNull();
  });

  it("treats a rejected ping IPC as a failure (not a crash)", async () => {
    const originalConsoleError = console.error;
    console.error = vi.fn();
    try {
      const { pingAiProvider } = personalizedWelcomeApi(async () => {
        throw new Error("IPC disconnected");
      });
      render(<PersonalizedWelcome open pingAiProvider={pingAiProvider} onContinue={() => {}} />);
      await waitFor(() => {
        expect(
          screen.getByTestId("personalized-welcome:ping-failure"),
        ).toBeTruthy();
      });
    } finally {
      console.error = originalConsoleError;
    }
  });

  it("pings exactly once across parent re-renders (stable function prop, no effect re-fire)", async () => {
    // Regression guard for the onboarding ping flicker: a parent re-render
    // (e.g. status-bar health upserts triggering an App re-render) must NOT
    // re-fire the mount-time ping effect. Because pingAiProvider is a stable
    // function reference — not a fresh `{ pingAiProvider }` object literal —
    // the effect dep array stays referentially equal and the probe runs once.
    const { pingAiProvider } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 120,
    }));
    const { rerender } = render(
      <PersonalizedWelcome
        open
        nickname="Ken"
        pingAiProvider={pingAiProvider}
        onContinue={() => {}}
      />,
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-success"),
      ).toBeTruthy();
    });
    expect(pingAiProvider).toHaveBeenCalledTimes(1);

    // Re-render with the SAME function reference but a changed unrelated prop,
    // mimicking the parent App re-rendering on each status-bar health update.
    for (let i = 0; i < 3; i++) {
      rerender(
        <PersonalizedWelcome
          open
          nickname={`Ken-${i}`}
          pingAiProvider={pingAiProvider}
          onContinue={() => {}}
        />,
      );
    }
    // Let any (incorrectly re-fired) async effect settle before asserting.
    await Promise.resolve();
    expect(pingAiProvider).toHaveBeenCalledTimes(1);
  });
});
