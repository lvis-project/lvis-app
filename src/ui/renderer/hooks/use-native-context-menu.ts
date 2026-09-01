import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import type {
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
  NativeMenuItem,
  NativeContextMenuAction,
  NativeContextMenuCommand,
  NativeContextMenuKind,
} from "../../../shared/native-context-menu.js";

/** A row as the renderer holds it: the payload plus what the row does. */
export interface NativeMenuRow {
  id: string;
  label: string;
  sublabel?: string;
  accelerator?: string;
  enabled?: boolean;
  submenu?: NativeMenuRow[];
  /** Leaf rows only — a row with a submenu opens it instead. */
  onSelect?: () => void | Promise<void>;
}

export type NativeContextMenuHandlers = Partial<
  Record<NativeContextMenuCommand, () => void | Promise<void>>
>;

type PendingNativeContextMenu = {
  requestId: string;
  handlers: NativeContextMenuHandlers;
};

/**
 * Renderer half of the native context-menu bridge. Main owns labels, ordering,
 * and the allow-list; this hook retains target data and callbacks locally and
 * correlates the returned fixed command id with an unguessable request id.
 */
export function useNativeContextMenu() {
  const pendingRef = useRef<PendingNativeContextMenu | null>(null);

  useEffect(() => {
    return window.lvis?.ui?.onNativeContextMenuAction?.(
      (action: NativeContextMenuAction) => {
        const pending = pendingRef.current;
        if (!pending || action.requestId !== pending.requestId) return;
        pendingRef.current = null;
        void pending.handlers[action.command]?.();
      },
    );
  }, []);

  return useCallback((
    event: MouseEvent<HTMLElement>,
    kind: NativeContextMenuKind,
    handlers: NativeContextMenuHandlers,
  ) => {
    // Yield to the global WebContents copy/select-all menu only when the
    // selection actually intersects this target. A stale selection elsewhere
    // must not suppress the target's application actions.
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed && selection.toString().trim()) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        try {
          if (selection.getRangeAt(index).intersectsNode(event.currentTarget)) {
            // Handled: the WebContents menu wins here, and an ancestor target
            // must not override that decision with its own menu.
            event.stopPropagation();
            return false;
          }
        } catch {
          // Ignore detached/stale ranges and continue with the target menu.
        }
      }
    }

    const show = window.lvis?.ui?.showNativeContextMenu;
    const commands = Object.keys(handlers) as NativeContextMenuCommand[];
    // Not handled — no bridge, or this target has nothing to offer right now.
    // Let the event keep bubbling so an ancestor target (e.g. the sidebar's
    // Projects tab behind a row) can still answer the right-click.
    if (!show || commands.length === 0) return false;

    // The innermost target that CAN answer owns the menu: without this, a
    // nested target's menu request is immediately replaced by its ancestor's
    // (both write the same `pendingRef`, and two popups race).
    event.stopPropagation();
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const requestId =
      globalThis.crypto?.randomUUID?.() ??
      "native-context-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    pendingRef.current = { requestId, handlers };

    void show({
      requestId,
      kind,
      commands,
      x: Math.round(event.clientX || rect.left),
      y: Math.round(event.clientY || rect.top),
    })
      .then((result) => {
        if (!result.ok && pendingRef.current?.requestId === requestId) {
          pendingRef.current = null;
        }
      })
      .catch(() => {
        if (pendingRef.current?.requestId === requestId) {
          pendingRef.current = null;
        }
      });
    return true;
  }, []);
}

/**
 * The other half of the native bridge, for a menu whose rows the renderer owns.
 *
 * `useNativeContextMenu` above hands main a `kind` and gets a fixed command
 * back; here the rows ARE the payload, so what comes back is one of the ids
 * this call sent. The handlers stay in this closure and the id is matched
 * against the request that produced them, so an action can only ever run the
 * callback the same call registered.
 */
export function useNativeMenu() {
  const pendingRef = useRef<{ requestId: string; run: Map<string, () => void | Promise<void>> } | null>(null);

  useEffect(() => {
    return window.lvis?.ui?.onDynamicMenuAction?.((action: DynamicNativeMenuAction) => {
      const pending = pendingRef.current;
      if (!pending || action.requestId !== pending.requestId) return;
      pendingRef.current = null;
      void pending.run.get(action.id)?.();
    });
  }, []);

  return useCallback(async (
    at: { x: number; y: number },
    sections: Array<{ items: NativeMenuRow[] }>,
  ): Promise<boolean> => {
    const show = window.lvis?.ui?.showDynamicMenu;
    if (typeof show !== "function") return false;
    const requestId = crypto.randomUUID();
    const run = new Map<string, () => void | Promise<void>>();
    // The tree is flattened into (id → callback) as it is serialised, so the id
    // main echoes back needs no lookup through the tree it came from.
    const strip = (rows: NativeMenuRow[]): NativeMenuItem[] =>
      rows.map((row) => {
        if (row.onSelect) run.set(row.id, row.onSelect);
        return {
          id: row.id,
          label: row.label,
          ...(row.sublabel === undefined ? {} : { sublabel: row.sublabel }),
          ...(row.accelerator === undefined ? {} : { accelerator: row.accelerator }),
          ...(row.enabled === undefined ? {} : { enabled: row.enabled }),
          ...(row.submenu === undefined ? {} : { submenu: strip(row.submenu) }),
        };
      });
    const payload: DynamicNativeMenuPayload = {
      requestId,
      x: Math.round(at.x),
      y: Math.round(at.y),
      sections: sections.map((section) => ({ items: strip(section.items) })),
    };
    pendingRef.current = { requestId, run };
    const result = await show(payload);
    if (result?.ok !== true) {
      // Only clear our own entry: two overlapping opens both write this ref, and
      // the loser resolving late must not strip the callbacks off the menu that
      // is currently on screen.
      if (pendingRef.current?.requestId === requestId) pendingRef.current = null;
      return false;
    }
    return true;
  }, []);
}
