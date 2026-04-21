// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { McpTab } from "../McpTab.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("McpTab remove flow", () => {
  it("prevents duplicate remove requests while one is already in flight", async () => {
    const removal = deferred<void>();
    const mcp = {
      servers: vi.fn(async () => []),
      kill: vi.fn(async () => undefined),
      getConfigs: vi.fn(async () => [{ id: "srv-a", transport: "http" as const, url: "https://example.com/mcp" }]),
      getConfigPath: vi.fn(async () => "/Users/ken/workspace/GIT/github/lvis-project/.isolated/pr191-opus-loop/lvis-app/.mcp.json"),
      addConfig: vi.fn(async () => ({ connected: true })),
      removeConfig: vi.fn(() => removal.promise),
    };

    vi.stubGlobal("lvis", { mcp });
    render(<McpTab />);

    const removeButton = await screen.findByRole("button", { name: "제거" });
    fireEvent.click(removeButton);
    fireEvent.click(removeButton);

    expect(mcp.removeConfig).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(removeButton).toBeDisabled());

    removal.resolve();

    await waitFor(() => expect(mcp.getConfigs).toHaveBeenCalledTimes(2));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
