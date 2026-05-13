// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PermissionMigrationBanner } from "../PermissionMigrationBanner.js";

interface MigrationApi {
  getMigrationStatus: ReturnType<typeof vi.fn>;
}

function installApi(
  result:
    | { ok: true; schemaVersion?: number; appliedAt?: string; behaviourChanged: boolean }
    | { ok: false; error: string },
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

  it("renders nothing when behaviourChanged=false (schema-only bump)", async () => {
    installApi({ ok: true, schemaVersion: 2, behaviourChanged: false });
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
  });

  it("renders nothing when appliedAt absent (defensive: behaviourChanged should already gate)", async () => {
    installApi({ ok: true, schemaVersion: 2, behaviourChanged: false });
    let container: HTMLElement;
    await act(async () => {
      const r = render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
      container = r.container;
    });
    expect(
      container!.querySelector('[data-testid="permission-migration-banner"]'),
    ).toBeNull();
  });

  it("renders the banner when migrator applied a behaviour-changing migration AND not yet dismissed", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
    });
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
    });
    const banner = screen.getByTestId("permission-migration-banner");
    expect(banner).toBeTruthy();
    expect(banner.getAttribute("data-schema-version")).toBe("2");
    // Copy emphasises continuity, not alarming wording (designer M2).
    expect(banner.textContent).toContain("위험도가 낮은 도구는 자동으로 허용");
  });

  it("dismiss glyph ✕ is hidden from assistive technology (designer m1 — aria-hidden wrapper)", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
    });
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
    });
    const dismiss = screen.getByTestId("permission-migration-banner-dismiss");
    expect(dismiss.getAttribute("aria-label")).toBe("권한 정책 업데이트 알림 닫기");
    // The visible glyph is wrapped in aria-hidden so screen readers
    // read the button's accessible name from aria-label, not the
    // glyph (which some readers announce as "multiplication sign").
    const glyph = dismiss.querySelector("span[aria-hidden=\"true\"]");
    expect(glyph?.textContent).toBe("✕");
  });

  it("renders an explicit '다음에' ghost button (designer m2 — JSDoc/UI parity)", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
    });
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={vi.fn()} />);
    });
    const later = screen.getByTestId("permission-migration-banner-later");
    expect(later.textContent).toContain("다음에");
  });

  it("'지금 확인' calls onOpenSettings('permissions') and dismisses persistently", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
    });
    const onOpen = vi.fn();
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-migration-banner-action"));
    });
    expect(onOpen).toHaveBeenCalledWith("permissions");
    expect(screen.queryByTestId("permission-migration-banner")).toBeNull();
    expect(window.localStorage.getItem("permission-migration-banner-v2-dismissed")).toBe(
      "true",
    );
  });

  it("'다음에' persists the dismissal without opening settings", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
    });
    const onOpen = vi.fn();
    await act(async () => {
      render(<PermissionMigrationBanner onOpenSettings={onOpen} />);
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("permission-migration-banner-later"));
    });
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.queryByTestId("permission-migration-banner")).toBeNull();
    expect(window.localStorage.getItem("permission-migration-banner-v2-dismissed")).toBe(
      "true",
    );
  });

  it("'✕' icon button also persists the dismissal", async () => {
    installApi({
      ok: true,
      schemaVersion: 2,
      appliedAt: "2026-05-14T01:00:00.000Z",
      behaviourChanged: true,
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
      behaviourChanged: true,
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
