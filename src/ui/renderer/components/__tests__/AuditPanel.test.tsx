// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuditPanel } from "../permissions/AuditPanel.js";
import type { PermissionAuditEntrySummary } from "../../types.js";

function makeEntry(overrides: Partial<PermissionAuditEntrySummary> = {}): PermissionAuditEntrySummary {
  return {
    auditId: "id-1",
    ts: "2026-05-09T12:00:00.000Z",
    decision: "allow",
    trustOrigin: "user-keyboard",
    prevHash: "deadbeef",
    tool: "fs_read",
    source: "builtin",
    category: "read",
    directory: "/tmp",
    directoryAllowed: true,
    layer: 1,
    ...overrides,
  } as PermissionAuditEntrySummary;
}

function makeFetcher(opts: {
  entries: PermissionAuditEntrySummary[];
  verify?:
    | { ok: true; intact: boolean; totalFiles: number; totalEntries: number; firstBrokenFile?: string; perDay: Array<{ file: string; totalLines: number; chainOk: boolean; firstBrokenLineIndex?: number; reason?: string; sealMatch: boolean | null }> }
    | { ok: false; error: string };
}) {
  const show = vi.fn(async (n: number) => ({
    ok: true as const,
    entries: opts.entries.slice(0, n),
    total: opts.entries.length,
    summary: { files: 1, bytes: 4096 },
  }));
  const verify = vi.fn(async () =>
    opts.verify ?? {
      ok: true as const,
      intact: true,
      totalFiles: 1,
      totalEntries: opts.entries.length,
      perDay: [
        {
          file: "2026-05-09.permission-audit.jsonl",
          totalLines: opts.entries.length,
          chainOk: true,
          sealMatch: true,
        },
      ],
    },
  );
  return { show, verify };
}

beforeEach(() => {
  delete (window as unknown as { lvis?: unknown }).lvis;
});

describe("AuditPanel", () => {
  it("renders nothing when open=false", () => {
    const fetcher = makeFetcher({ entries: [makeEntry()] });
    const { container } = render(
      <AuditPanel open={false} onClose={() => {}} fetcher={fetcher} />,
    );
    expect(container.querySelector('[data-testid="audit-panel"]')).toBeNull();
  });

  it("renders panel + fetches entries on mount", async () => {
    const fetcher = makeFetcher({ entries: [makeEntry({ tool: "fs_write" })] });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    expect(screen.getByTestId("audit-panel")).toBeTruthy();
    expect(fetcher.show).toHaveBeenCalledWith(50);
    expect(fetcher.verify).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByText("fs_write")).toBeTruthy();
    });
  });

  it("shows green integrity banner on intact chain", async () => {
    const fetcher = makeFetcher({ entries: [makeEntry()] });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    await waitFor(() => {
      const banner = screen.getByTestId("audit-integrity-banner");
      expect(banner.getAttribute("data-severity")).toBe("ok");
    });
  });

  it("shows red banner + first broken file on chain break", async () => {
    const fetcher = makeFetcher({
      entries: [makeEntry()],
      verify: {
        ok: true as const,
        intact: false,
        totalFiles: 1,
        totalEntries: 5,
        firstBrokenFile: "2026-05-09.permission-audit.jsonl",
        perDay: [
          {
            file: "2026-05-09.permission-audit.jsonl",
            totalLines: 5,
            chainOk: false,
            firstBrokenLineIndex: 3,
            reason: "hmac-mismatch",
            sealMatch: null,
          },
        ],
      },
    });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    await waitFor(() => {
      const banner = screen.getByTestId("audit-integrity-banner");
      expect(banner.getAttribute("data-severity")).toBe("broken");
      expect(banner.textContent).toContain("2026-05-09.permission-audit.jsonl");
      expect(banner.textContent).toContain("line 3");
    });
  });

  it("filters entries by decision", async () => {
    const fetcher = makeFetcher({
      entries: [
        makeEntry({ auditId: "a1", decision: "allow", tool: "fs_read" }),
        makeEntry({ auditId: "d1", decision: "deny", tool: "fs_write" }),
      ],
    });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    await waitFor(() => expect(screen.getByText("fs_read")).toBeTruthy());
    fireEvent.change(screen.getByTestId("audit-decision-filter"), {
      target: { value: "deny" },
    });
    await waitFor(() => {
      expect(screen.queryByText("fs_read")).toBeNull();
      expect(screen.getByText("fs_write")).toBeTruthy();
    });
  });

  it("filters entries by tool name substring", async () => {
    const fetcher = makeFetcher({
      entries: [
        makeEntry({ auditId: "a1", tool: "fs_read" }),
        makeEntry({ auditId: "a2", tool: "shell_run" }),
      ],
    });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    fireEvent.change(screen.getByTestId("audit-tool-filter"), {
      target: { value: "shell" },
    });
    await waitFor(() => {
      expect(screen.queryByText("fs_read")).toBeNull();
      expect(screen.getByText("shell_run")).toBeTruthy();
    });
  });

  it("expands an entry to show full discriminated union", async () => {
    const fetcher = makeFetcher({
      entries: [makeEntry({ auditId: "expand-me", tool: "fs_read" })],
    });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    expect(screen.queryByTestId("audit-entry-detail-expand-me")).toBeNull();
    fireEvent.click(screen.getByText("fs_read"));
    await waitFor(() => {
      const detail = screen.getByTestId("audit-entry-detail-expand-me");
      expect(detail).toBeTruthy();
      expect(detail.textContent).toContain('"auditId": "expand-me"');
    });
  });

  it("shows only the public execution-plan projection for a Windows Plan-B audit entry", async () => {
    const executionPlan = {
      version: "host-shell-execution-plan/v2",
      identity: "host-shell-execution-plan/v2:win32:windows-partial-shell-acl-unsafe",
      platform: "win32",
      requestedSandbox: true,
      mode: "plain",
      fallbackReason: "windows-partial-shell-acl-unsafe",
      requiresExplicitUserApproval: true,
      capability: {
        kind: "none",
        confidence: "verified",
        platform: "win32",
        confines: { filesystem: false, process: false, network: false },
      },
    };
    const fetcher = makeFetcher({
      entries: [makeEntry({
        auditId: "windows-plan-b",
        tool: "powershell",
        toolUseId: "tool-use-plan-b",
        executionPlan,
      })],
    });

    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    fireEvent.click(screen.getByText("powershell"));

    await waitFor(() => {
      const detail = screen.getByTestId("audit-entry-detail-windows-plan-b");
      const rendered = JSON.parse(detail.textContent ?? "{}") as {
        executionPlan?: Record<string, unknown>;
      };
      expect(rendered.executionPlan).toEqual(executionPlan);
      expect(detail.textContent).not.toContain("hostShellExecutionPermitBinding");
      expect(detail.textContent).not.toContain("oneShotPermitBinding");
      expect(detail.textContent).not.toContain("permit");
      expect(detail.textContent).not.toContain("binding");
      expect(detail.textContent).not.toContain("command");
      expect(detail.textContent).not.toContain("requestedCwd");
      expect(detail.textContent).not.toContain("allowedDirectories");
    });
  });

  it("invokes onClose when × is clicked", async () => {
    const fetcher = makeFetcher({ entries: [] });
    const onClose = vi.fn();
    await act(async () => {
      render(<AuditPanel open onClose={onClose} fetcher={fetcher} />);
    });
    fireEvent.click(screen.getByTestId("audit-panel-close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("re-runs verify when '다시 검증' clicked", async () => {
    const fetcher = makeFetcher({ entries: [makeEntry()] });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    expect(fetcher.verify).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("audit-verify-button"));
    await waitFor(() => expect(fetcher.verify).toHaveBeenCalledTimes(2));
  });

  it("renders 'no entries' empty state", async () => {
    const fetcher = makeFetcher({ entries: [] });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    await waitFor(() => {
      expect(screen.getByText("표시할 감사 기록이 없습니다.")).toBeTruthy();
    });
  });

  it("warn-severity banner when chain ok but seals null", async () => {
    const fetcher = makeFetcher({
      entries: [makeEntry()],
      verify: {
        ok: true as const,
        intact: true,
        totalFiles: 1,
        totalEntries: 1,
        perDay: [
          {
            file: "2026-05-09.permission-audit.jsonl",
            totalLines: 1,
            chainOk: true,
            sealMatch: null,
          },
        ],
      },
    });
    await act(async () => {
      render(<AuditPanel open onClose={() => {}} fetcher={fetcher} />);
    });
    await waitFor(() => {
      const banner = screen.getByTestId("audit-integrity-banner");
      expect(banner.getAttribute("data-severity")).toBe("warn");
    });
  });
});
