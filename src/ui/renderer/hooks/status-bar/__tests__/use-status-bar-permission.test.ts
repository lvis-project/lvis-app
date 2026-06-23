// @vitest-environment jsdom
import "../../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useStatusBarPermission } from "../use-status-bar-permission.js";
import type { LvisApi } from "../../../types.js";
import type { PersistentItem } from "../types.js";

function makeApi(overrides: Record<string, unknown> = {}): LvisApi {
  return {
    permission: {
      getMode: vi.fn(async () => ({ mode: "strict" })),
      deferredList: vi.fn(async () => ({ ok: true, pending: [], total: 0 })),
      onModeChanged: vi.fn(() => () => undefined),
      onDeferredPending: vi.fn(() => () => undefined),
      ...overrides,
    },
  } as unknown as LvisApi;
}

describe("useStatusBarPermission", () => {
  it("renders the active permission mode as a plain-text value item (no pill/badge)", async () => {
    const api = makeApi();
    const items: PersistentItem[] = [];
    const upsertPersistent = (item: PersistentItem) => {
      const i = items.findIndex((p) => p.id === item.id);
      if (i === -1) items.push(item);
      else items[i] = item;
    };
    renderHook(() => useStatusBarPermission({ api, upsertPersistent }));

    await waitFor(() => {
      const cell = items.find((p) => p.id === "permission:mode");
      expect(cell).toBeTruthy();
      // Plain text — value-only, no emoji glyph label, not a dot.
      expect(cell?.value && cell.value.length > 0).toBe(true);
      expect(cell?.dot).toBeUndefined();
    });
  });

  it("appends the pending-approval count when the deferred queue is non-empty", async () => {
    const api = makeApi({
      deferredList: vi.fn(async () => ({ ok: true, pending: [{}, {}], total: 2 })),
    });
    const items: PersistentItem[] = [];
    const upsertPersistent = (item: PersistentItem) => {
      const i = items.findIndex((p) => p.id === item.id);
      if (i === -1) items.push(item);
      else items[i] = item;
    };
    renderHook(() => useStatusBarPermission({ api, upsertPersistent }));

    await waitFor(() => {
      const cell = items.find((p) => p.id === "permission:mode");
      expect(cell?.severity).toBe("warning");
      expect(cell?.value).toContain("2");
    });
  });
});
