import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import type { AwayAuthorityStatus } from "../../../../shared/away-authority-arm.js";
import type { LvisApi } from "../../types.js";
import { AwayAuthorityContent } from "../AwayAuthorityContent.js";

const PROJECT = "/home/owner/project";
const NOTES = "/home/owner/notes";

function makeApi(initial: AwayAuthorityStatus | null = null) {
  let current = initial;
  const status = vi.fn(async () => ({ ok: true as const, status: current }));
  const arm = vi.fn(async () => ({ ok: true as const }));
  const disarm = vi.fn(async () => ({ ok: true as const }));
  const api = { awayAuthority: { status, arm, disarm } } as unknown as LvisApi;
  return {
    api,
    arm,
    disarm,
    status,
    setStatus(next: AwayAuthorityStatus | null) {
      current = next;
    },
  };
}

function stubWorkspaceRoots(roots: readonly string[]): void {
  (globalThis as unknown as { window: { lvis?: unknown } }).window.lvis = {
    workspace: {
      listRoots: vi.fn(async () => ({
        ok: true,
        roots: roots.map((path) => ({ path, isDefault: path === roots[0] })),
      })),
    },
  };
}

async function openDialog(
  roots: readonly string[] = [PROJECT, NOTES],
  chatGroupId = "main",
) {
  stubWorkspaceRoots(roots);
  const harness = makeApi(null);
  render(<AwayAuthorityContent api={harness.api} chatGroupId={chatGroupId} shareIsLive />);
  await screen.findByTestId("away-authority-not-armed");
  fireEvent.click(screen.getByTestId("away-authority-open-arm-dialog"));
  await screen.findByTestId("away-authority-arm-dialog");
  if (roots.length > 0) await screen.findByTestId(`away-authority-folder-${roots[0]}`);
  return harness;
}

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
});

afterEach(() => {
  setLocale(localeBeforeTest);
  delete (globalThis as unknown as { window: { lvis?: unknown } }).window.lvis;
});

describe("Away authority desk controls", () => {
  it("says nothing is armed and offers to arm when the share is live", async () => {
    stubWorkspaceRoots([PROJECT]);
    const harness = makeApi(null);

    render(<AwayAuthorityContent api={harness.api} chatGroupId="main" shareIsLive />);

    expect(await screen.findByTestId("away-authority-not-armed")).toBeInTheDocument();
    expect(screen.getByTestId("away-authority-open-arm-dialog")).toBeEnabled();
    expect(screen.queryByTestId("away-authority-armed")).not.toBeInTheDocument();
  });

  it("refuses to offer arming for a conversation the share does not point at", async () => {
    stubWorkspaceRoots([PROJECT]);
    const harness = makeApi(null);

    render(<AwayAuthorityContent api={harness.api} chatGroupId="main" shareIsLive={false} />);

    await screen.findByTestId("away-authority-not-armed");
    expect(screen.getByTestId("away-authority-open-arm-dialog")).toBeDisabled();
    expect(screen.getByTestId("away-authority-requires-open-shared-conversation"))
      .toBeInTheDocument();
  });

  it("shows what an armed grant may do, where, and how much is left", async () => {
    stubWorkspaceRoots([PROJECT]);
    const harness = makeApi({
      writable: true,
      directories: [PROJECT],
      expiresAt: Date.now() + 3_600_000,
      remaining: 7,
    });

    render(<AwayAuthorityContent api={harness.api} chatGroupId="main" shareIsLive />);

    const armed = await screen.findByTestId("away-authority-armed");
    expect(armed).toHaveTextContent("answering file reads and writes");
    expect(armed).toHaveTextContent("7 calls left");
    expect(armed).toHaveTextContent(PROJECT);
    expect(screen.getByTestId("away-authority-disarm")).toBeInTheDocument();
  });

  it("distinguishes a read-only grant from a writing one", async () => {
    stubWorkspaceRoots([PROJECT]);
    const harness = makeApi({
      writable: false,
      directories: [PROJECT],
      expiresAt: Date.now() + 3_600_000,
      remaining: 4,
    });

    render(<AwayAuthorityContent api={harness.api} chatGroupId="main" shareIsLive />);

    const armed = await screen.findByTestId("away-authority-armed");
    expect(armed).toHaveTextContent("answering file reads");
    expect(armed).not.toHaveTextContent("and writes");
  });

  it("disarms through main and re-reads the status", async () => {
    stubWorkspaceRoots([PROJECT]);
    const harness = makeApi({
      writable: false,
      directories: [PROJECT],
      expiresAt: Date.now() + 3_600_000,
      remaining: 4,
    });

    render(<AwayAuthorityContent api={harness.api} chatGroupId="main" shareIsLive />);
    await screen.findByTestId("away-authority-armed");
    harness.setStatus(null);
    fireEvent.click(screen.getByTestId("away-authority-disarm"));

    await waitFor(() => expect(harness.disarm).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("away-authority-not-armed")).toBeInTheDocument();
  });

  it("surfaces a refused arming instead of reporting success", async () => {
    const harness = await openDialog([PROJECT]);
    harness.arm.mockResolvedValueOnce({ ok: false, error: "away-authority-operation-rejected" } as never);
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));

    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));

    expect(await screen.findByTestId("away-authority-arm-error")).toHaveTextContent(
      "That away-answering scope was refused.",
    );
    expect(screen.getByTestId("away-authority-arm-dialog")).toBeInTheDocument();
  });
});

describe("Away authority arm dialog — scope disclosure", () => {
  it("states the whole scope in the dialog itself, not behind a link", async () => {
    await openDialog();

    expect(screen.getByTestId("away-authority-scope")).toHaveTextContent(
      "only file reads and writes inside the folders you pick below",
    );
    expect(screen.getByTestId("away-authority-pathless")).toHaveTextContent(
      "A tool call that names no file is refused rather than answered",
    );
    expect(screen.getByTestId("away-authority-never-armed")).toHaveTextContent(
      "Shell commands, network tools",
    );
    expect(screen.getByTestId("away-authority-impersonation")).toHaveTextContent(
      "cannot tell your Telegram messages from anyone else's",
    );
    expect(screen.getByTestId("away-authority-injection")).toHaveTextContent(
      "can steer the tool calls that follow",
    );
    expect(screen.getByTestId("away-authority-still-blocked")).toHaveTextContent(
      "a sensitive path is blocked outright",
    );
    expect(screen.getByTestId("away-authority-retirement")).toHaveTextContent(
      "whenever this app restarts",
    );
  });

  it("tells the owner there is nothing to bound a grant with when no root exists", async () => {
    await openDialog([]);

    expect(screen.getByTestId("away-authority-folders-empty")).toBeInTheDocument();
    expect(screen.getByTestId("away-authority-confirm-arm")).toBeDisabled();
  });
});

describe("Away authority arm dialog — arming write deliberately", () => {
  it("opens read-only, so a straight-through click cannot arm writing", async () => {
    const harness = await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));

    expect(screen.getByTestId("away-authority-confirm-arm")).toHaveTextContent("Arm read-only");
    expect(screen.queryByTestId("away-authority-write-acknowledge")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));

    await waitFor(() => expect(harness.arm).toHaveBeenCalledTimes(1));
    expect(harness.arm).toHaveBeenCalledWith({
      chatGroupId: "main",
      mode: "read-only",
      directories: [PROJECT],
      duration: "1h",
      budget: 10,
    });
  });

  it("names the focused tile, so the grant binds to the conversation on screen", async () => {
    // Main reads what THAT tile is holding. Sending nothing would leave main
    // arming whatever the primary loop happened to hold — a conversation the
    // owner may not even be looking at.
    const harness = await openDialog([PROJECT], "group-3");
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));

    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));

    await waitFor(() => expect(harness.arm).toHaveBeenCalledTimes(1));
    expect(harness.arm).toHaveBeenCalledWith(expect.objectContaining({ chatGroupId: "group-3" }));
  });

  it("will not arm writing until the consequence is acknowledged", async () => {
    const harness = await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));
    fireEvent.click(screen.getByTestId("away-authority-mode-read-write"));

    const confirm = screen.getByTestId("away-authority-confirm-arm");
    expect(confirm).toHaveTextContent("Arm reads and writes");
    expect(confirm).toBeDisabled();

    fireEvent.click(confirm);
    expect(harness.arm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("away-authority-write-acknowledge"));
    expect(screen.getByTestId("away-authority-confirm-arm")).toBeEnabled();

    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));
    await waitFor(() => expect(harness.arm).toHaveBeenCalledTimes(1));
    expect(harness.arm).toHaveBeenCalledWith(expect.objectContaining({ mode: "read-write" }));
  });

  it("withdraws the write acknowledgement when the folder set changes under it", async () => {
    const harness = await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));
    fireEvent.click(screen.getByTestId("away-authority-mode-read-write"));
    fireEvent.click(screen.getByTestId("away-authority-write-acknowledge"));
    expect(screen.getByTestId("away-authority-confirm-arm")).toBeEnabled();

    fireEvent.click(screen.getByTestId(`away-authority-folder-${NOTES}`));

    expect(screen.getByTestId("away-authority-confirm-arm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));
    expect(harness.arm).not.toHaveBeenCalled();
  });

  it("withdraws the write acknowledgement when the mode is toggled back and forth", async () => {
    await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));
    fireEvent.click(screen.getByTestId("away-authority-mode-read-write"));
    fireEvent.click(screen.getByTestId("away-authority-write-acknowledge"));
    expect(screen.getByTestId("away-authority-confirm-arm")).toBeEnabled();

    fireEvent.click(screen.getByTestId("away-authority-mode-read-only"));
    fireEvent.click(screen.getByTestId("away-authority-mode-read-write"));

    expect(screen.getByTestId("away-authority-confirm-arm")).toBeDisabled();
  });

  it("refuses to arm a grant with no folder at all", async () => {
    const harness = await openDialog();

    expect(screen.getByTestId("away-authority-confirm-arm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));

    expect(harness.arm).not.toHaveBeenCalled();
  });

  it("reopens read-only with nothing selected after a write arming", async () => {
    const harness = await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));
    fireEvent.click(screen.getByTestId("away-authority-mode-read-write"));
    fireEvent.click(screen.getByTestId("away-authority-write-acknowledge"));
    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));
    await waitFor(() => expect(harness.arm).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByTestId("away-authority-open-arm-dialog"));
    await screen.findByTestId("away-authority-arm-dialog");

    expect(screen.getByTestId("away-authority-confirm-arm")).toHaveTextContent("Arm read-only");
    expect(screen.getByTestId("away-authority-confirm-arm")).toBeDisabled();
  });

  it("sends the duration and budget the owner chose", async () => {
    const harness = await openDialog();
    fireEvent.click(screen.getByTestId(`away-authority-folder-${PROJECT}`));
    fireEvent.change(screen.getByTestId("away-authority-duration"), { target: { value: "4h" } });
    fireEvent.change(screen.getByTestId("away-authority-budget"), { target: { value: "50" } });

    fireEvent.click(screen.getByTestId("away-authority-confirm-arm"));

    await waitFor(() => expect(harness.arm).toHaveBeenCalledTimes(1));
    expect(harness.arm).toHaveBeenCalledWith(expect.objectContaining({
      duration: "4h",
      budget: 50,
    }));
  });
});
