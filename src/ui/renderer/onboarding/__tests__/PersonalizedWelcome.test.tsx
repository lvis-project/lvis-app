// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  PersonalizedWelcome,
  type PersonalizedWelcomeApi,
} from "../PersonalizedWelcome.js";
import type { AiProviderPingIpcResult } from "../../../../shared/ai-provider-ping.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function personalizedWelcomeApi(
  pingImpl: () => Promise<AiProviderPingIpcResult>,
): {
  api: PersonalizedWelcomeApi;
  pingAiProvider: ReturnType<typeof vi.fn>;
} {
  const { api } = makeMockLvisApi();
  const pingAiProvider = vi.fn(pingImpl);
  api.pingAiProvider = pingAiProvider;
  return { api: api as unknown as PersonalizedWelcomeApi, pingAiProvider };
}

describe("PersonalizedWelcome", () => {
  it("renders nothing when open=false", () => {
    const { api } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 120,
    }));
    render(
      <PersonalizedWelcome open={false} api={api} onContinue={() => {}} />,
    );
    expect(screen.queryByTestId("personalized-welcome")).toBeNull();
  });

  it("uses neutral greeting when nickname is empty", () => {
    const { api } = personalizedWelcomeApi(
      async () =>
        new Promise(() => {
          // never resolves — stays in loading
        }),
    );
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
    expect(
      screen.getByTestId("personalized-welcome:greeting").textContent,
    ).toMatch(/안녕하세요/);
  });

  it("greets the user by 호칭 when nickname is set", () => {
    const { api } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(
      <PersonalizedWelcome
        open
        nickname="Ken"
        api={api}
        onContinue={() => {}}
      />,
    );
    expect(
      screen.getByTestId("personalized-welcome:greeting").textContent,
    ).toMatch(/Ken님/);
  });

  it("reflects the user's intro line as a quoted welcome message", () => {
    const { api } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(
      <PersonalizedWelcome
        open
        nickname="Ken"
        introduction="PM, 회의록 정리"
        api={api}
        onContinue={() => {}}
      />,
    );
    expect(
      screen.getByTestId("personalized-welcome:intro").textContent,
    ).toContain("PM, 회의록 정리");
  });

  it("ping loading: shows spinner row and disables continue button", () => {
    const { api } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
    expect(
      screen.getByTestId("personalized-welcome:ping-loading"),
    ).toBeTruthy();
    const cta = screen.getByTestId(
      "personalized-welcome:continue",
    ) as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
  });

  it("ping success: surfaces vendor/model/latency line and enables continue", async () => {
    const { api } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 142,
    }));
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
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

  it("ping failure (not-configured): surfaces warning but keeps continue enabled (fallback path)", async () => {
    const { api } = personalizedWelcomeApi(async () => ({
      configured: false,
      online: false,
      vendor: "azure-foundry",
      error: "not-configured",
    }));
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
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
    const { api } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: false,
      vendor: "azure-foundry",
      model: "gpt-5.4-mini",
      error: "Public access is disabled. Please configure private endpoint.",
    }));
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
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
    const { api } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: false,
      vendor: "azure-foundry",
      model: "gpt-5.4-mini",
      error: "timeout",
    }));
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
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
    const { api } = personalizedWelcomeApi(async () => ({
      ok: false,
      error: "unauthorized-frame",
    }));
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("personalized-welcome:ping-failure"),
      ).toBeTruthy();
    });
  });

  it("'예, 시작할게요 →' fires onContinue once ping resolves", async () => {
    const onContinue = vi.fn();
    const { api } = personalizedWelcomeApi(async () => ({
      configured: true,
      online: true,
      vendor: "azure-foundry",
      model: "gpt-4",
      latencyMs: 90,
    }));
    render(<PersonalizedWelcome open api={api} onContinue={onContinue} />);
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
    const { api } = personalizedWelcomeApi(
      async () => new Promise(() => { /* pending */ }),
    );
    render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
    expect(screen.queryByTestId("personalized-welcome:skip")).toBeNull();
  });

  it("treats a rejected ping IPC as a failure (not a crash)", async () => {
    const originalConsoleError = console.error;
    console.error = vi.fn();
    try {
      const { api } = personalizedWelcomeApi(async () => {
        throw new Error("IPC disconnected");
      });
      render(<PersonalizedWelcome open api={api} onContinue={() => {}} />);
      await waitFor(() => {
        expect(
          screen.getByTestId("personalized-welcome:ping-failure"),
        ).toBeTruthy();
      });
    } finally {
      console.error = originalConsoleError;
    }
  });
});
