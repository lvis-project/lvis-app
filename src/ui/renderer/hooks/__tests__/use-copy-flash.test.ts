// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { COPY_FLASH_MS, useCopyFlash } from "../use-copy-flash.js";

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
});

describe("useCopyFlash", () => {
  it("writes the value, shows copied once the write resolves, and clears after the ttl", async () => {
    const { result } = renderHook(() => useCopyFlash());
    expect(result.current.copied).toBe(false);

    await act(async () => { result.current.copy("pair-1234"); });
    expect(writeText).toHaveBeenCalledWith("pair-1234");
    expect(result.current.copied).toBe(true);

    act(() => { vi.advanceTimersByTime(COPY_FLASH_MS - 1); });
    expect(result.current.copied).toBe(true);
    act(() => { vi.advanceTimersByTime(1); });
    expect(result.current.copied).toBe(false);
  });

  it("honours a caller-supplied ttl and restarts it on a second copy", async () => {
    const { result } = renderHook(() => useCopyFlash(500));
    await act(async () => { result.current.copy("a"); });
    act(() => { vi.advanceTimersByTime(400); });
    await act(async () => { result.current.copy("b"); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(result.current.copied).toBe(true);
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current.copied).toBe(false);
  });

  it("shows nothing for a write the clipboard refused, an empty value, or no clipboard", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const { result } = renderHook(() => useCopyFlash());
    await act(async () => { result.current.copy("secret"); });
    expect(result.current.copied).toBe(false);

    await act(async () => { result.current.copy(""); });
    expect(writeText).toHaveBeenCalledTimes(1);

    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    await act(async () => { result.current.copy("value"); });
    expect(result.current.copied).toBe(false);
  });

  it("reset drops the confirmation before the ttl", async () => {
    const { result } = renderHook(() => useCopyFlash());
    await act(async () => { result.current.copy("x"); });
    expect(result.current.copied).toBe(true);
    act(() => { result.current.reset(); });
    expect(result.current.copied).toBe(false);
  });
});
