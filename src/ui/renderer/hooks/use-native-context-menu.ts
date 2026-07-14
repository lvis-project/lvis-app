import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import type {
  NativeContextMenuAction,
  NativeContextMenuCommand,
  NativeContextMenuKind,
} from "../../../shared/native-context-menu.js";

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
            return false;
          }
        } catch {
          // Ignore detached/stale ranges and continue with the target menu.
        }
      }
    }

    const show = window.lvis?.ui?.showNativeContextMenu;
    const commands = Object.keys(handlers) as NativeContextMenuCommand[];
    if (!show || commands.length === 0) return false;

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
