// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PermissionMigrationBanner } from "../PermissionMigrationBanner.js";

interface MigrationApi {
  getMigrationStatus: ReturnType<typeof vi.fn>;
}

function installApi(
  result: { ok: true; schemaVersion?: number; appliedAt?: string } | { ok: false; error: string },
): MigrationApi {
  const getMigrationStatus = vi.fn(async () => result);
  (globalThis as unknown as { window: { lvis: unknown } }).window.lvis = {
    permission: { getMigrationStatus },
  };
  return { getMigrationStatus };
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
  window.localStorage.clear();
});

describe("PermissionMigrationBanner", () => {
  it("renders nothing when getMigrationStatus returns ok=false", async () => {
    installApi({ ok: false, error: "boom" });
    const onOpen = vi.fn();
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={onOpen} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders nothing when appliedAt is absent (fresh install)", async () => {
    installApi({ ok: true, schemaVersion: 2 });
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
  });

  it("renders the banner when migration applied AND not yet dismissed", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
    });
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
    });
    const banner = screen.getByTestId("permission-migration-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-schema-version")).toBe("2");
    expect(banner.textContent).toContain("권한 정책이 업데이트");
  });

  it("'지금 확인' calls onOpenSettings('permissions') and dismisses persistently", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
    });
    const onOpen = vi.fn();
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-migration-banner-action"));
    });
    expect(onOpen).toHaveBeenCalledWith("permissions");
    // Banner unmounts/hides on click.
    expect(screen.queryByTestId("permission-migration-banner")).toBeNull();
    // Persisted dismissal flag scoped to the applied schemaVersion.
    expect(window.localStorage.getItem("permission-migration-banner-v2-dismissed")).toBe(
      "true",
    );
  });

  it("'다음에' (dismiss button) persists the dismissal without opening settings", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
    });
    const onOpen = vi.fn();
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-migration-banner-dismiss"));
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId("permission-migration-banner")).toBeNull();
    expect(window.localStorage.getItem("permission-migration-banner-v2-dismissed")).toBe(
      "true",
    );
  });

  it("stays hidden on remount once the user has dismissed", async () => {
    window.localStorage.setItem("permission-migration-banner-v2-dismissed", "true");
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
    });
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
  });

  it("renders nothing when window.lvis is absent", async () => {
    delete (window as unknown as { lvis?: unknown }).lvis;
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
  });
});
