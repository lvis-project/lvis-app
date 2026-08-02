import "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RolesTab } from "../RolesTab.js";
import type { LvisApi } from "../../types.js";
import { SavedToastProvider } from "../../contexts/saved-toast.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { t } from "../../../../i18n/runtime.js";

function renderRolesTab(api: Record<string, unknown>) {
  return render(
    <SavedToastProvider value={vi.fn()}>
      <RolesTab api={api as unknown as LvisApi} />
    </SavedToastProvider>,
  );
}

describe("RolesTab — long-term memory consolidation", () => {
  it("runs manual consolidation and reports an updated global or project scope", async () => {
    const { api } = makeMockLvisApi();
    api.memoryRefreshLongTerm.mockResolvedValue({
      ok: true,
      global: { status: "up-to-date", sourceCount: 2 },
      project: { status: "updated", sourceCount: 1, consolidatedAt: "2026-08-02T00:00:00.000Z" },
    });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:refresh-long-term-memory"));

    await waitFor(() => expect(api.memoryRefreshLongTerm).toHaveBeenCalledOnce());
    expect(await screen.findByText(t("rolesTab.statusLongTermMemoryConsolidated"))).toBeInTheDocument();
  });

  it("keeps service failures localized instead of exposing host error details", async () => {
    const { api } = makeMockLvisApi();
    api.memoryRefreshLongTerm.mockResolvedValue({
      ok: false,
      error: "memory-consolidation-service-unavailable",
    });
    renderRolesTab(api);

    fireEvent.click(await screen.findByTestId("roles-tab:refresh-long-term-memory"));

    expect(await screen.findByText(t("rolesTab.errorLongTermMemoryConsolidationUnavailable"))).toBeInTheDocument();
  });
});
