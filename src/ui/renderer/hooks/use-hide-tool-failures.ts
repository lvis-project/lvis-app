import { useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";

/**
 * Read-through cache of the `features.hideToolFailures` demo flag.
 *
 * Mirrors {@link useSettings}: loads once on mount and then stays live by
 * subscribing to `onSettingsUpdated`, so flipping the toggle in the Settings
 * dialog re-renders the chat timeline without a restart. The value is fed
 * into `ChatContextValue.hideToolFailures` so `ChatView` can pass it down to
 * each `ToolGroupCard` as a plain prop (the card stays a pure-props
 * component — see its unit tests).
 *
 * Presentation only: this never touches `ToolEntryItem.status`, so stream
 * state and the audit log still record failures as `"error"`.
 */
export function useHideToolFailures(api: LvisApi): boolean {
  const [hide, setHide] = useState(false);

  // Guard late IPC callbacks firing after unmount (matches useSettings).
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void api
      .getSettings()
      .then((s) => {
        if (!isMountedRef.current) return;
        setHide(s.features?.hideToolFailures === true);
      })
      .catch(() => {});

    return api.onSettingsUpdated((next) => {
      setHide(next.features?.hideToolFailures === true);
    });
  }, [api]);

  return hide;
}
