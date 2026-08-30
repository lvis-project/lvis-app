/**
 * The floating dock's policy — geometry, admission, and lifetime.
 *
 * The geometry cases are the security ones. What stops an attached card from
 * covering the screen is a cap the plugin cannot reach, and a cap that is only
 * asserted through a real window is a cap nobody re-checks. Both bounds are
 * pure functions so they can be checked directly.
 *
 * The lifetime cases are the correctness ones. Every detach must reach the
 * plugin exactly once and carry its reason — a recorder that hears "user
 * closed the dock" has an orphaned session to clean up, and one that hears
 * nothing keeps recording into a window that is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCK_CHROME_HEIGHT,
  DOCK_MARGIN,
  DOCK_WIDTH,
  FloatingDock,
  FloatingDockError,
  MAX_SLOT_HEIGHT,
  MIN_SLOT_HEIGHT,
  __resetPanelSeqForTests,
  clampSlotHeight,
  dockBounds,
  maxDockHeight,
  type DetachReason,
  type DockActivity,
  type DockBounds,
  type DockSurfaceEvent,
  type FloatingDockSurface,
  type ResolvedFloatingSurface,
  type WorkArea,
} from "../floating-dock.js";

const WORK_AREA: WorkArea = { x: 0, y: 0, width: 1920, height: 1080 };

const SURFACE: ResolvedFloatingSurface = {
  pluginId: "meeting",
  extensionId: "recorder",
  entryUrl: "file:///plugins/meeting/dist/ui/recorder.js?lvisRuntimeRevision=3",
  title: "Recorder",
};

/** A surface that records what it was told and lets a test drive the window. */
function stubSurface(workArea: WorkArea = WORK_AREA) {
  const calls: string[] = [];
  const mounted: Array<{ panelId: string; surface: ResolvedFloatingSurface; height: number }> = [];
  const bounds: DockBounds[] = [];
  const activities: Array<DockActivity | null> = [];
  const area = { current: workArea };
  let emit: ((event: DockSurfaceEvent) => void) | undefined;

  const surface: FloatingDockSurface = {
    workArea: () => area.current,
    show: (b) => {
      calls.push("show");
      bounds.push(b);
    },
    setBounds: (b) => {
      calls.push("setBounds");
      bounds.push(b);
    },
    hide: () => calls.push("hide"),
    mountSlot: (panelId, resolved, height) => {
      calls.push(`mount:${panelId}`);
      mounted.push({ panelId, surface: resolved, height });
    },
    resizeSlot: (panelId, height) => calls.push(`resize:${panelId}:${height}`),
    unmountSlot: (panelId) => calls.push(`unmount:${panelId}`),
    setActivity: (a) => activities.push(a),
    onSurfaceEvent: (listener) => {
      emit = listener;
    },
  };

  return {
    surface,
    calls,
    mounted,
    bounds,
    activities,
    area,
    fire: (event: DockSurfaceEvent) => emit?.(event),
  };
}

beforeEach(() => {
  __resetPanelSeqForTests();
});

describe("clampSlotHeight", () => {
  const ROOMY = 10_000;

  it("defaults to the floor when nothing is asked for", async () => {
    expect(clampSlotHeight(undefined, ROOMY)).toBe(MIN_SLOT_HEIGHT);
  });

  it("passes an in-range height through, rounded", async () => {
    expect(clampSlotHeight(200.4, ROOMY)).toBe(200);
  });

  it("raises a too-small request to the floor", async () => {
    expect(clampSlotHeight(4, ROOMY)).toBe(MIN_SLOT_HEIGHT);
  });

  it("caps at the per-slot ceiling even when the dock has room to spare", async () => {
    expect(clampSlotHeight(9999, ROOMY)).toBe(MAX_SLOT_HEIGHT);
  });

  it("caps at the room left when that is the tighter bound", async () => {
    expect(clampSlotHeight(9999, 150)).toBe(150);
  });

  it("refuses rather than squeezing below the floor", async () => {
    // A slot the user can see but cannot read is worse than being told there
    // is no room. The plugin can retry; a 12px card is just broken.
    try {
      clampSlotHeight(200, 12);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as FloatingDockError).code).toBe("dock-full");
    }
  });

  it.each<[string, number]>([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["negative", -300],
  ])("refuses %s rather than substituting a default", async (_name, value) => {
    // Substituting the floor would turn a plugin's arithmetic bug into a slot
    // that merely looks wrong, with nothing to report.
    try {
      clampSlotHeight(value, 10_000);
      expect.unreachable("should have refused");
    } catch (error) {
      expect((error as FloatingDockError).code).toBe("invalid-height");
    }
  });
});

describe("dockBounds", () => {
  it("anchors bottom-right of the work area with a margin", async () => {
    expect(dockBounds(200, WORK_AREA)).toEqual({
      x: 1920 - DOCK_WIDTH - DOCK_MARGIN,
      y: 1080 - 200 - DOCK_MARGIN,
      width: DOCK_WIDTH,
      height: 200,
    });
  });

  it("respects a work area that does not start at the origin", async () => {
    // A second display, or a docked taskbar. Ignoring the offset would put the
    // dock on the wrong screen entirely.
    expect(dockBounds(200, { x: -1920, y: 40, width: 1920, height: 1000 })).toMatchObject({
      x: -1920 + 1920 - DOCK_WIDTH - DOCK_MARGIN,
      y: 40 + 1000 - 200 - DOCK_MARGIN,
    });
  });

  it("does not push the dock off the top of a work area shorter than itself", async () => {
    // Only `y` is pinned here: 800 - 360 - 16 still leaves room horizontally,
    // so the x anchor is the ordinary one. A dock whose top went negative
    // would put its close control off-screen.
    expect(dockBounds(900, { x: 0, y: 0, width: 800, height: 400 })).toMatchObject({
      x: 800 - DOCK_WIDTH - DOCK_MARGIN,
      y: 0,
    });
  });

  it("pins x too when the work area is narrower than the dock", async () => {
    expect(dockBounds(200, { x: 0, y: 0, width: 300, height: 900 })).toMatchObject({ x: 0 });
  });

  it("keeps the width fixed regardless of the height", async () => {
    expect(dockBounds(700, WORK_AREA).width).toBe(DOCK_WIDTH);
  });
});

describe("FloatingDock activity", () => {
  it("shows the window on the first activity and hides it when cleared", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);

    dock.setActivity({ conversation: "Quarterly report", summary: "Indexing 3 documents" });
    expect(dock.visible).toBe(true);
    // The line says WHOSE work it is. One line, up to four conversations: an
    // unlabelled line cannot be attributed, and the next one to arrive
    // replaces it without the user knowing what it replaced.
    expect(stub.activities[stub.activities.length - 1]).toMatchObject({
      conversation: "Quarterly report",
      summary: "Indexing 3 documents",
    });

    dock.setActivity(null);
    // A window floating above every other application with nothing in it is
    // clutter the user did not ask for.
    expect(dock.visible).toBe(false);
    expect(stub.calls).toContain("hide");
  });

  it("keeps the dock up when activity clears but a panel is still attached", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    dock.setActivity({ conversation: "Quarterly report", summary: "working" });
    dock.attach("meeting", { extensionId: "recorder" });

    dock.setActivity(null);

    expect(dock.visible).toBe(true);
  });

  it("shows the window for an attachment even with no activity at all", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);

    dock.attach("meeting", { extensionId: "recorder" });

    expect(dock.visible).toBe(true);
  });
});

describe("FloatingDock attachment", () => {
  it("mounts a declared surface at a clamped height and lays the dock out", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);

    const handle = dock.attach("meeting", { extensionId: "recorder", height: 9999 });

    expect(handle.height).toBe(MAX_SLOT_HEIGHT);
    // Clamped BEFORE the mount — the surface never saw the raw number, so
    // nothing painted at 9999px even for a frame.
    expect(stub.mounted[0]).toMatchObject({ height: MAX_SLOT_HEIGHT });
    expect(dock.height).toBe(DOCK_CHROME_HEIGHT + MAX_SLOT_HEIGHT);
  });

  it("refuses with the resolver's code rather than a generic failure", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => "surface-not-floating");

    try {
      dock.attach("meeting", { extensionId: "sidebar-card" });
      expect.unreachable("attach should have thrown");
    } catch (error) {
      expect((error as FloatingDockError).code).toBe("surface-not-floating");
    }
    // A refusal that still mounted would have refused too late.
    expect(stub.mounted).toHaveLength(0);
    expect(dock.visible).toBe(false);
  });

  it("returns the same slot for a repeat attach of the same surface", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);

    const first = dock.attach("meeting", { extensionId: "recorder" });
    const second = dock.attach("meeting", { extensionId: "recorder" });

    expect(second.panelId).toBe(first.panelId);
    expect(stub.mounted).toHaveLength(1);
    expect(dock.attachedCount).toBe(1);
  });

  it("keeps different surfaces of the same plugin apart", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, (_p, extensionId) => ({ ...SURFACE, extensionId }));

    dock.attach("meeting", { extensionId: "recorder" });
    dock.attach("meeting", { extensionId: "levels" });

    expect(dock.attachedCount).toBe(2);
  });

  it("admits later attachments against the room the earlier ones left", async () => {
    // The bound that matters. Per-slot caps alone would let several
    // attachments add up to a full-screen overlay.
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, (pluginId, extensionId) => ({
      ...SURFACE,
      pluginId,
      extensionId,
    }));

    dock.attach("a", { extensionId: "one", height: MAX_SLOT_HEIGHT });
    dock.attach("b", { extensionId: "two", height: MAX_SLOT_HEIGHT });

    expect(dock.height).toBeLessThanOrEqual(maxDockHeight(WORK_AREA));
  });

  it("refuses an attachment once the dock is full", async () => {
    const stub = stubSurface({ x: 0, y: 0, width: 1200, height: 600 });
    const dock = new FloatingDock(stub.surface, (pluginId, extensionId) => ({
      ...SURFACE,
      pluginId,
      extensionId,
    }));
    // 0.6 * 600 = 360, minus 76 of chrome, leaves 284 — the first attachment
    // takes all of it and nothing else fits.
    dock.attach("a", { extensionId: "one", height: MAX_SLOT_HEIGHT });

    try {
      dock.attach("b", { extensionId: "two" });
      expect.unreachable("dock should be full");
    } catch (error) {
      expect((error as FloatingDockError).code).toBe("dock-full");
    }
  });
});

describe("FloatingDock slot lifetime", () => {
  it("clamps a resize the same way and reports what was applied", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });

    expect(await handle.resize(9999)).toBe(MAX_SLOT_HEIGHT);
    expect(handle.height).toBe(MAX_SLOT_HEIGHT);
    expect(stub.calls).toContain(`resize:${handle.panelId}:${MAX_SLOT_HEIGHT}`);
  });

  it("does not count a slot's own height against its own resize", async () => {
    // Measuring against the full dock would make growing an existing slot
    // impossible as soon as the dock neared its cap — the slot would be
    // competing with itself.
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder", height: 400 });

    expect(await handle.resize(MAX_SLOT_HEIGHT)).toBe(MAX_SLOT_HEIGHT);
  });

  it("re-reads the work area on resize", async () => {
    // The user can move the app to another display mid-recording. A cap
    // computed once at attach would then be the wrong screen's cap.
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });

    stub.area.current = { x: 0, y: 0, width: 1200, height: 600 };
    expect(await handle.resize(9999)).toBe(maxDockHeight(stub.area.current) - DOCK_CHROME_HEIGHT);
  });

  it("notifies once with the reason when the user closes the dock", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    const seen: DetachReason[] = [];
    handle.onDetached((reason) => seen.push(reason));

    stub.fire({ kind: "dock-closed" });
    stub.fire({ kind: "dock-closed" });

    // Once, not twice: a second notification would cancel an already-cancelled
    // recording. The reason has to survive so an orphaned session can be told
    // apart from a deliberate stop.
    expect(seen).toEqual(["user-closed"]);
    expect(dock.attachedCount).toBe(0);
    expect(dock.visible).toBe(false);
  });

  it("carries a renderer crash through as its own reason", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    const seen: DetachReason[] = [];
    handle.onDetached((reason) => seen.push(reason));

    stub.fire({ kind: "slot-gone", panelId: handle.panelId, reason: "renderer-gone" });

    expect(seen).toEqual(["renderer-gone"]);
  });

  it("survives a listener that throws and still notifies the rest", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    const second = vi.fn();
    handle.onDetached(() => {
      throw new Error("listener blew up");
    });
    handle.onDetached(second);

    await expect(handle.detach()).resolves.toBeUndefined();
    expect(second).toHaveBeenCalledWith("requested");
    expect(dock.attachedCount).toBe(0);
  });

  it("tells a late subscriber the slot is already gone", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    await handle.detach();

    const late = vi.fn();
    handle.onDetached(late);

    // Silence would leave the subscriber waiting for an event that has already
    // happened.
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("makes detach idempotent", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });

    await handle.detach();
    await handle.detach();

    expect(stub.calls.filter((c) => c === `unmount:${handle.panelId}`)).toHaveLength(1);
  });

  it("refuses a resize after detach instead of silently doing nothing", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    await handle.detach();

    await expect(handle.resize(200)).rejects.toThrow(/detached/u);
  });

  it("lets a surface be re-attached after it detaches", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, () => SURFACE);
    await dock.attach("meeting", { extensionId: "recorder" }).detach();

    dock.attach("meeting", { extensionId: "recorder" });

    expect(stub.mounted).toHaveLength(2);
  });

  it("detaches only the named plugin's slots", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, (pluginId, extensionId) => ({
      ...SURFACE,
      pluginId,
      extensionId,
    }));
    const kept = dock.attach("meeting-notes", { extensionId: "recorder" });
    dock.attach("meeting", { extensionId: "recorder" });

    dock.detachForPlugin("meeting");

    // Exact id, not a prefix: "meeting" must not take "meeting-notes" with it.
    expect(dock.attachedCount).toBe(1);
    expect(kept.height).toBe(MIN_SLOT_HEIGHT);
  });

  it("detaches everything and takes the window down on shutdown", async () => {
    const stub = stubSurface();
    const dock = new FloatingDock(stub.surface, (pluginId, extensionId) => ({
      ...SURFACE,
      pluginId,
      extensionId,
    }));
    dock.setActivity({ conversation: "Quarterly report", summary: "working" });
    const handle = dock.attach("meeting", { extensionId: "recorder" });
    const seen: DetachReason[] = [];
    handle.onDetached((reason) => seen.push(reason));

    dock.shutdown();

    expect(seen).toEqual(["host-shutdown"]);
    expect(dock.attachedCount).toBe(0);
    expect(dock.visible).toBe(false);
  });
});
