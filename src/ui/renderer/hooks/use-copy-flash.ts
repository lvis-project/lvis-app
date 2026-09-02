/**
 * Copy a value to the clipboard and flash "copied" for a moment.
 *
 * One implementation for every copy button that confirms itself inline. The
 * copies this replaced disagreed on the flash (1500 ms, 1200 ms, or never
 * resetting — the pairing-code buttons read "copied" until the component
 * remounted) and on whether "copied" meant the write succeeded or merely that
 * the button was pressed. Here it means the write resolved: a clipboard that
 * refuses the write, or is absent, shows no confirmation for a copy that did
 * not happen.
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** How long the "copied" confirmation stays up. */
export const COPY_FLASH_MS = 1500;

export interface CopyFlash {
  copied: boolean;
  copy: (value: string) => void;
  /** Drop the confirmation now — the value it confirmed has been replaced. */
  reset: () => void;
}

export function useCopyFlash(ttlMs: number = COPY_FLASH_MS): CopyFlash {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearResetTimer = useCallback(() => {
    if (resetTimer.current === null) return;
    clearTimeout(resetTimer.current);
    resetTimer.current = null;
  }, []);

  useEffect(() => clearResetTimer, [clearResetTimer]);

  const reset = useCallback(() => {
    clearResetTimer();
    setCopied(false);
  }, [clearResetTimer]);

  const copy = useCallback(
    (value: string) => {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      if (!value || typeof clipboard?.writeText !== "function") return;
      void clipboard.writeText(value).then(
        () => {
          setCopied(true);
          clearResetTimer();
          resetTimer.current = setTimeout(() => {
            resetTimer.current = null;
            setCopied(false);
          }, ttlMs);
        },
        () => reset(),
      );
    },
    [clearResetTimer, reset, ttlMs],
  );

  return { copied, copy, reset };
}
