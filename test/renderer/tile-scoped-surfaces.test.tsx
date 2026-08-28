/**
 * What belongs to a TILE and what belongs to the WINDOW, with two tiles open.
 *
 * Main pushes several surfaces at the renderer that predate tiled chat groups.
 * Each one has to answer the same question — is this news about one
 * conversation or about the window? — and the answer decides whether it is
 * subscribed per tile or once, and which tile gets to show it.
 */
import "./setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { splitIntoTwoTiles } from "./helpers.js";
import type { MockLvisApi } from "./mock-lvis-api.js";

/** The permission namespace's subscriptions, as the mock records them. */
function permissionSubscription(api: MockLvisApi, name: string): ReturnType<typeof vi.fn> {
  return (api.permission as unknown as Record<string, ReturnType<typeof vi.fn>>)[name]!;
}

describe("permission disclosure toasts with two tiles", () => {
  it("subscribes and renders once for the window, not once per tile", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onHit = permissionSubscription(api, "onUserApprovalHit");
    await waitFor(() => expect(onHit).toHaveBeenCalled());

    await splitIntoTwoTiles(container);

    // The setting these report on is the window's, so a second conversation
    // must not bring a second subscription with it.
    expect(onHit).toHaveBeenCalledTimes(1);

    const fire = onHit.mock.calls[0]?.[0] as (payload: {
      toolName: string;
      scope: "session" | "persistent";
      verdictAtApproval: "low" | "medium" | "high";
    }) => void;
    await act(async () => {
      fire({ toolName: "fs_write", scope: "persistent", verdictAtApproval: "low" });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="user-approval-hit-toast"]'),
      ).toHaveLength(1);
    });
  });

  it("raises the review suggestion once however many conversations are open", async () => {
    const { container, api } = await renderApp({ hasApiKey: true });
    const onSuggestion = permissionSubscription(api, "onReviewSuggestion");
    await waitFor(() => expect(onSuggestion).toHaveBeenCalled());

    await splitIntoTwoTiles(container);
    expect(onSuggestion).toHaveBeenCalledTimes(1);

    const fire = onSuggestion.mock.calls[0]?.[0] as (payload: {
      reason: "allow-always" | "repeat-allow";
      allowCount: number;
      allowAlwaysCount: number;
      threshold: number;
      windowMs: number;
    }) => void;
    await act(async () => {
      fire({
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    });

    await waitFor(() => {
      expect(
        container.querySelectorAll('[data-testid="permission-review-suggestion-toast"]'),
      ).toHaveLength(1);
    });
  });
});
