/**
 * The floating dock — one host-owned window that stays above everything, and
 * the slots plugins attach their cards into.
 *
 * WHAT IT IS FOR. Two things the app cannot do from inside its own window:
 * show you what it is currently working on while you are looking at something
 * else, and let a plugin put a live surface — a recorder, a timer, a progress
 * readout — where you can actually see it. Both wanted a window that floats.
 * Neither wanted a *different* window.
 *
 * SO THERE IS EXACTLY ONE. The dock belongs to the host. It has a host-drawn
 * header, a host-drawn activity line, and below that a stack of slots. A
 * plugin does not open a window; it attaches a card into a slot and the host
 * frames it.
 *
 * WHY ONE AND NOT ONE EACH. A plugin that could open its own frameless,
 * transparent, always-on-top window can draw anything anywhere, including a
 * convincing copy of the host's own approval dialog over the real one — the
 * user's click then lands somewhere they cannot see. Inside the dock that
 * attack has nowhere to stand: the host's chrome is always around the plugin's
 * pixels, the dock's position and width are the host's, and the dock's total
 * height is capped ({@link maxDockHeight}) so no set of attachments can grow
 * to cover a screen. The plugin's own always-on-top window is what this
 * replaces, so this is a privilege reduction, not a new grant.
 *
 * WHAT A PLUGIN DECIDES: which of ITS OWN declared floating surfaces to
 * attach, how tall the slot should be within the host's range, and when to
 * detach. That is the whole surface.
 *
 * The card inside a slot is served by the same `plugin-ui-shell.html` the
 * sidebar uses, over the same `lvis:plugin:*` bridge — so an attached card
 * already has `callTool`, `emitEvent`, config, storage and theme. That is why
 * an attachment handle carries no message channel of its own: a card that
 * needs to talk to its plugin calls the plugin's tools, exactly as a sidebar
 * card does.
 */
// The plugin-facing contract is the SOT for these shapes; this file conforms
// to it rather than declaring a second copy that could drift from what the
// SDK mirrors.
import type {
  AttachFloatingPanelRequest,
  DetachReason,
  FloatingPanelHandle,
} from "../plugins/public-contract.js";

export type { AttachFloatingPanelRequest, DetachReason, FloatingPanelHandle };

/** Dock width, in device-independent pixels. The host's, not a parameter. */
export const DOCK_WIDTH = 360;

/** Height of the host's own header + activity line, above every slot. */
export const DOCK_CHROME_HEIGHT = 76;

/** Floor for a slot. Below this a card cannot paint anything. */
export const MIN_SLOT_HEIGHT = 72;

/** Absolute ceiling for one slot, independent of display size. */
export const MAX_SLOT_HEIGHT = 480;

/**
 * Ceiling for the WHOLE dock, as a fraction of the primary work area.
 *
 * The bound that matters. Per-slot caps alone would let four attachments add
 * up to a full-screen overlay, so the dock's total height is capped here and
 * each slot is admitted against the room that remains.
 */
const MAX_DOCK_WORK_AREA_RATIO = 0.6;

/** Gap between the dock and the work-area edges it is anchored to. */
export const DOCK_MARGIN = 16;

/** Why an attach, resize or detach was refused. */
export type FloatingDockErrorCode =
  | "unknown-plugin"
  | "surface-not-declared"
  | "surface-not-floating"
  | "surface-has-no-entry"
  | "surface-entry-rejected"
  | "invalid-height"
  | "dock-full"
  | "slot-detached"
  | "dock-unavailable";

/**
 * A refusal, carrying its reason as a code rather than only as prose.
 *
 * The codes are the plugin-visible vocabulary. "You asked for a surface you
 * did not declare" and "the dock has no room left" are different facts, and a
 * plugin that cannot tell them apart cannot report either one usefully — the
 * first is a bug in the plugin, the second is a condition to retry.
 */
export class FloatingDockError extends Error {
  readonly code: FloatingDockErrorCode;

  constructor(code: FloatingDockErrorCode, message: string) {
    super(`[floating-dock] ${message}`);
    this.name = "FloatingDockError";
    this.code = code;
  }
}

/** What the host resolved about a surface, before any slot exists. */
export interface ResolvedFloatingSurface {
  readonly pluginId: string;
  readonly extensionId: string;
  /** `file://` URL of the plugin's declared entry module, revision-stamped. */
  readonly entryUrl: string;
  /** Shown in the host-drawn slot header. The host's text, from the manifest. */
  readonly title: string;
}

/** A rectangle of usable screen — Electron's `Display.workArea`, narrowed. */
export interface WorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Where the dock sits, computed entirely by the host. */
export interface DockBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the host shows in its own line, above every plugin slot. */
export interface DockActivity {
  /** One line: what the app is doing right now. */
  readonly summary: string;
  /** `null` when the work has no measurable progress. */
  readonly progress?: number | null;
  /** Optional second line — the task's own title, a file name, a step. */
  readonly detail?: string;
}

/** Something the window told the service about, rather than the other way. */
export type DockSurfaceEvent =
  | { readonly kind: "dock-closed" }
  | { readonly kind: "slot-gone"; readonly panelId: string; readonly reason: DetachReason };

/**
 * The window operations the dock needs, behind an interface so the policy in
 * this module is testable without an Electron display attached.
 */
export interface FloatingDockSurface {
  /** The primary display's usable rectangle. */
  workArea(): WorkArea;
  /** Create and show the dock window. Called once, lazily. */
  show(bounds: DockBounds): void;
  /** Re-lay the dock after its total height changes. */
  setBounds(bounds: DockBounds): void;
  /** Hide and destroy the dock window. */
  hide(): void;
  /** Put a plugin card into a slot. */
  mountSlot(panelId: string, surface: ResolvedFloatingSurface, height: number): void;
  /** Change one slot's height. */
  resizeSlot(panelId: string, height: number): void;
  /** Remove one slot's card. */
  unmountSlot(panelId: string): void;
  /** Push the host's own activity line. */
  setActivity(activity: DockActivity | null): void;
  /**
   * The user closed the dock, or a slot's renderer died. Registered once by
   * the service at construction.
   */
  onSurfaceEvent(listener: (event: DockSurfaceEvent) => void): void;
}

/**
 * Resolve a plugin's declared floating surface. Supplied by the caller because
 * the manifest lives in the plugin runtime, which this module deliberately
 * does not import — the runtime is a large graph and this policy is small.
 */
export type FloatingSurfaceResolver = (
  pluginId: string,
  extensionId: string,
) => ResolvedFloatingSurface | FloatingDockErrorCode;

/** The most a dock may occupy on a given display. */
export function maxDockHeight(workArea: WorkArea): number {
  return Math.floor(workArea.height * MAX_DOCK_WORK_AREA_RATIO);
}

/**
 * Clamp a requested slot height into the host's range, given the room left.
 *
 * `available` is what remains of {@link maxDockHeight} after the chrome and
 * the slots already attached. Exported and pure because it is the number that
 * bounds how much screen a plugin can occupy, and a bound only asserted
 * through a window is a bound nobody re-checks.
 *
 * Refuses a non-finite or non-positive request rather than substituting a
 * default: a plugin that computed `NaN` has a bug, and silently opening a
 * 72px slot would hide it.
 */
export function clampSlotHeight(requested: number | undefined, available: number): number {
  const wanted = requested ?? MIN_SLOT_HEIGHT;
  if (!Number.isFinite(wanted) || wanted <= 0) {
    throw new FloatingDockError(
      "invalid-height",
      `height must be a positive finite number, got ${JSON.stringify(requested)}`,
    );
  }
  if (available < MIN_SLOT_HEIGHT) {
    // Not a clamp — a refusal. Squeezing a card into less than its floor
    // produces a slot the user can see but cannot read, which is worse than
    // telling the plugin there is no room.
    throw new FloatingDockError(
      "dock-full",
      `no room for another panel: ${available}px left, ${MIN_SLOT_HEIGHT}px needed`,
    );
  }
  const ceiling = Math.min(MAX_SLOT_HEIGHT, available);
  return Math.min(ceiling, Math.max(MIN_SLOT_HEIGHT, Math.round(wanted)));
}

/**
 * Bottom-right of the work area, inset by {@link DOCK_MARGIN}.
 *
 * Pure, so the anchor is asserted directly. A dock that drifted off the bottom
 * of a short display would be a dock the user cannot close.
 */
export function dockBounds(height: number, workArea: WorkArea): DockBounds {
  const x = workArea.x + Math.max(0, workArea.width - DOCK_WIDTH - DOCK_MARGIN);
  const y = workArea.y + Math.max(0, workArea.height - height - DOCK_MARGIN);
  return { x, y, width: DOCK_WIDTH, height };
}

let nextPanelSeq = 0;

interface Slot {
  readonly panelId: string;
  readonly pluginId: string;
  readonly extensionId: string;
  height: number;
  detached: boolean;
  readonly listeners: Set<(reason: DetachReason) => void>;
}

/**
 * The dock, and everything attached to it.
 *
 * One instance per host. The window is created lazily on the first thing worth
 * showing and destroyed when the last one goes away — a window floating above
 * every other application with nothing in it is not a neutral default, it is
 * clutter the user did not ask for.
 */
export class FloatingDock {
  readonly #surface: FloatingDockSurface;
  readonly #resolve: FloatingSurfaceResolver;
  /** Insertion-ordered; the dock renders slots in this order. */
  readonly #slots = new Map<string, Slot>();
  #activity: DockActivity | null = null;
  #visible = false;

  constructor(surface: FloatingDockSurface, resolve: FloatingSurfaceResolver) {
    this.#surface = surface;
    this.#resolve = resolve;
    this.#surface.onSurfaceEvent((event) => this.#onSurfaceEvent(event));
  }

  get attachedCount(): number {
    return this.#slots.size;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Total height the dock currently wants: chrome plus every live slot. */
  get height(): number {
    let total = DOCK_CHROME_HEIGHT;
    for (const slot of this.#slots.values()) total += slot.height;
    return total;
  }

  /**
   * Publish what the app is doing. `null` clears the line.
   *
   * The host's own content, and the reason the dock is useful with no plugin
   * attached at all.
   */
  setActivity(activity: DockActivity | null): void {
    this.#activity = activity;
    if (activity === null && this.#slots.size === 0) {
      this.#teardown();
      return;
    }
    this.#ensureVisible();
    this.#surface.setActivity(activity);
  }

  attach(pluginId: string, request: AttachFloatingPanelRequest): FloatingPanelHandle {
    const existing = this.#findSlot(pluginId, request.extensionId);
    if (existing) return this.#handleFor(existing);

    const resolved = this.#resolve(pluginId, request.extensionId);
    if (typeof resolved === "string") {
      throw new FloatingDockError(
        resolved,
        `plugin '${pluginId}' cannot attach '${request.extensionId}': ${resolved}`,
      );
    }

    const workArea = this.#surface.workArea();
    // Clamped BEFORE anything is mounted. A slot mounted at the requested size
    // and corrected afterwards would have painted at that size for at least
    // one frame, which on an always-on-top surface is exactly long enough.
    const height = clampSlotHeight(request.height, maxDockHeight(workArea) - this.height);

    const panelId = `dock-panel-${++nextPanelSeq}`;
    const slot: Slot = {
      panelId,
      pluginId,
      extensionId: resolved.extensionId,
      height,
      detached: false,
      listeners: new Set(),
    };
    this.#slots.set(panelId, slot);
    this.#ensureVisible();
    this.#surface.mountSlot(panelId, resolved, height);
    this.#relayout();
    return this.#handleFor(slot);
  }

  /**
   * Resize a slot named by id, on behalf of the plugin that owns it.
   *
   * The addressable form of {@link FloatingPanelHandle.resize}, for the wire.
   * `pluginId` is the CALLER's, taken from the binding rather than the
   * request, so a plugin naming another's panel gets `slot-detached` — the
   * same answer a stale id gets, because "not yours" and "not there any more"
   * are the same fact from the caller's side and distinguishing them would
   * tell one plugin about another's slots.
   */
  resizeByPanelId(pluginId: string, panelId: string, height: number): number {
    const slot = this.#slots.get(panelId);
    if (!slot || slot.pluginId !== pluginId) {
      throw new FloatingDockError("slot-detached", `panel ${panelId} is not an open slot of '${pluginId}'`);
    }
    return this.#applyResize(slot, height);
  }

  /** Detach a slot named by id, on behalf of the plugin that owns it. */
  detachByPanelId(pluginId: string, panelId: string): void {
    const slot = this.#slots.get(panelId);
    // Silent on a slot that is gone: detach is idempotent, and a child whose
    // handle outlived the slot is the ordinary race rather than an error.
    if (!slot || slot.pluginId !== pluginId) return;
    this.#settle(slot, "requested");
  }

  /** Detach every slot a plugin owns — deactivation, reload, uninstall. */
  detachForPlugin(pluginId: string): void {
    for (const slot of [...this.#slots.values()]) {
      if (slot.pluginId !== pluginId) continue;
      this.#settle(slot, "plugin-stopped");
    }
  }

  /** Detach everything and take the window down. App shutdown. */
  shutdown(): void {
    for (const slot of [...this.#slots.values()]) this.#settle(slot, "host-shutdown");
    this.#activity = null;
    this.#teardown();
  }

  #applyResize(slot: Slot, next: number): number {
    if (slot.detached) {
      throw new FloatingDockError("slot-detached", `panel ${slot.panelId} is detached`);
    }
    // Measured against the room left EXCLUDING this slot's own current height,
    // so a resize is not refused because of the space it is already using.
    const available = maxDockHeight(this.#surface.workArea()) - (this.height - slot.height);
    slot.height = clampSlotHeight(next, available);
    this.#surface.resizeSlot(slot.panelId, slot.height);
    this.#relayout();
    return slot.height;
  }

  #findSlot(pluginId: string, extensionId: string): Slot | undefined {
    for (const slot of this.#slots.values()) {
      if (slot.pluginId === pluginId && slot.extensionId === extensionId) return slot;
    }
    return undefined;
  }

  #handleFor(slot: Slot): FloatingPanelHandle {
    return {
      panelId: slot.panelId,
      get height() {
        return slot.height;
      },
      resize: async (next: number): Promise<number> => this.#applyResize(slot, next),
      detach: async (): Promise<void> => {
        this.#settle(slot, "requested");
      },
      onDetached: (listener) => {
        if (slot.detached) {
          // Late subscriber on a dead slot. Silence would leave it waiting for
          // an event that already happened.
          this.#notify(listener, "requested");
          return;
        }
        slot.listeners.add(listener);
      },
    };
  }

  #settle(slot: Slot, reason: DetachReason): void {
    if (slot.detached) return;
    slot.detached = true;
    this.#slots.delete(slot.panelId);
    this.#surface.unmountSlot(slot.panelId);
    for (const listener of slot.listeners) this.#notify(listener, reason);
    slot.listeners.clear();
    if (this.#slots.size === 0 && this.#activity === null) {
      this.#teardown();
      return;
    }
    this.#relayout();
  }

  #notify(listener: (reason: DetachReason) => void, reason: DetachReason): void {
    // One listener throwing must not cost the others their notification, nor
    // leave the dock mid-teardown. Same isolation the capture service applies
    // to its frame listeners.
    try {
      listener(reason);
    } catch {
      /* a listener's failure is the listener's */
    }
  }

  #onSurfaceEvent(event: DockSurfaceEvent): void {
    if (event.kind === "dock-closed") {
      // The user dismissed the whole dock. Every attachment goes with it, and
      // each plugin hears why — a recorder whose window vanished has an
      // orphaned session to clean up.
      for (const slot of [...this.#slots.values()]) this.#settle(slot, "user-closed");
      this.#activity = null;
      this.#teardown();
      return;
    }
    const slot = this.#slots.get(event.panelId);
    if (slot) this.#settle(slot, event.reason);
  }

  #ensureVisible(): void {
    if (this.#visible) return;
    this.#visible = true;
    this.#surface.show(dockBounds(this.height, this.#surface.workArea()));
  }

  #relayout(): void {
    if (!this.#visible) return;
    this.#surface.setBounds(dockBounds(this.height, this.#surface.workArea()));
  }

  #teardown(): void {
    if (!this.#visible) return;
    this.#visible = false;
    this.#surface.hide();
  }
}

/** @internal — test-only, so panel ids are predictable across files. */
export function __resetPanelSeqForTests(): void {
  nextPanelSeq = 0;
}
