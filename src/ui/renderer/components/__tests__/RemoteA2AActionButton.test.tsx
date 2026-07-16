// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteA2AActionButton } from "../RemoteA2AActionButton.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";

function installApi(status: Record<string, unknown> = { state: "idle", updatedAt: "2026-07-16T00:00:00.000Z" }) {
  const send = vi.fn(async () => ({ ok: true, status: { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", targetAgentId: 1, targetLabel: "Agent one", outcome: "success", updatedAt: "2026-07-16T00:00:01.000Z" } }));
  const task = vi.fn(async () => ({ ok: true, status }));
  const action = vi.fn(async () => ({ ok: true, status }));
  Object.defineProperty(window, "lvisApi", {
    configurable: true,
    value: {
      remoteA2a: {
        targets: vi.fn(async () => ({ ok: true, targets: [{ targetAgentId: 1, label: "Agent one" }] })),
        status: vi.fn(async () => ({ ok: true, status })),
        send,
        task,
        action,
      },
    },
  });
  return { send, task, action };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

async function openPanel() {
  await act(async () => { render(<TooltipProvider><RemoteA2AActionButton /></TooltipProvider>); });
  fireEvent.click(await screen.findByTestId("remote-a2a-trigger"));
  return await screen.findByTestId("remote-a2a-panel");
}

describe("RemoteA2AActionButton production IPC surface", () => {
  it("sends only the selected target and user intent through the stable UI controls", async () => {
    const api = installApi();
    await openPanel();
    fireEvent.change(screen.getByTestId("remote-a2a-intent"), { target: { value: "Do the bounded task" } });
    fireEvent.click(screen.getByTestId("remote-a2a-send"));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(1, "Do the bounded task"));
    expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("sent");
  });

  it("exposes Replay only for an operation-recovery handle without fabricating Task actions", async () => {
    const api = installApi({ state: "failed", taskHandle: "recovery_handle_123", taskAvailable: false, recoveryEligible: true, outcome: "unknown-manual-reconciliation-required", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-replay")).toBeTruthy();
    expect(screen.queryByTestId("remote-a2a-get")).toBeNull();
    expect(screen.queryByTestId("remote-a2a-resume")).toBeNull();
    expect(screen.queryByTestId("remote-a2a-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("remote-a2a-replay"));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("replay", "recovery_handle_123", undefined));
  });

  it("shows AUTH_REQUIRED as out-of-band and disables credential-bearing Resume", async () => {
    installApi({ state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, recoveryEligible: false, taskState: "TASK_STATE_AUTH_REQUIRED", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-status").textContent).toContain("out of band");
    expect(screen.getByTestId("remote-a2a-resume")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("remote-a2a-replay")).toBeNull();
  });
});
