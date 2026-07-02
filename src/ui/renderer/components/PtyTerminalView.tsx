/**
 * PtyTerminalView — xterm.js frontend for the real interactive PTY terminal
 * (#1444). One instance per workspace terminal tab. The PTY itself lives in the
 * MAIN process (pty-manager.ts) inside the ASRT sandbox; this component only
 * renders output and forwards keystrokes/resize over the internal `terminal`
 * IPC surface.
 *
 * LIFECYCLE: `spawn` is idempotent per `tabId` — mounting (or re-mounting after
 * a ChatSidePanel unmount) replays the main-side scrollback rather than starting
 * a fresh shell, so the terminal state survives rail close / session switch. On
 * unmount we dispose the xterm instance + IPC subscriptions but DO NOT kill the
 * PTY (the tab-close path in the store owns kill).
 *
 * i18n: process/diagnostic lines (spawn failure, exit) are written into the
 * xterm BUFFER as terminal content — the same channel a real shell prints
 * "[Process completed]" on — not into localized app chrome, so this component
 * adds no i18n catalog keys.
 */
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { LvisApi } from "../types.js";

/** Dim-yellow ANSI wrapper for host-emitted diagnostic lines in the buffer. */
function diagnostic(text: string): string {
  return `\r\n\x1b[33m${text}\x1b[0m\r\n`;
}

export function PtyTerminalView({ api, tabId }: { api: LvisApi; tabId: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const terminalApi = api.terminal;
    // `terminal` is only ever undefined in test fixtures that cast a partial
    // object to LvisApi — production preload always defines it.
    if (!host || !terminalApi) return;

    let disposed = false;
    // xterm's canvas renderer cannot resolve CSS custom properties, so read the
    // ACTIVE theme tokens off the DOM at runtime and hand xterm concrete colors.
    // This keeps the component theme-aware (a bundle switch re-tints it) without
    // any source-level color literal (color-token-gate compliant).
    const readToken = (name: string, fallbackTriple: string): string => {
      const raw = getComputedStyle(host).getPropertyValue(name).trim();
      return `hsl(${raw || fallbackTriple})`;
    };
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 12,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      theme: {
        background: readToken("--background", "222.2 84% 4.9%"),
        foreground: readToken("--foreground", "210 40% 98%"),
      },
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const safeFit = (): { cols: number; rows: number } => {
      try {
        fit.fit();
      } catch {
        /* host not laid out yet — ResizeObserver retries */
      }
      return { cols: term.cols, rows: term.rows };
    };

    const { cols, rows } = safeFit();

    // Forward keystrokes → PTY stdin.
    const inputSub = term.onData((data) => {
      void terminalApi.input(tabId, data);
    });

    // Main → renderer output / exit.
    const offData = terminalApi.onData((payload) => {
      if (payload.tabId !== tabId) return;
      term.write(payload.chunk);
    });
    const offExit = terminalApi.onExit((payload) => {
      if (payload.tabId !== tabId) return;
      term.write(diagnostic(`[process exited: code ${payload.exitCode}]`));
    });

    // Spawn (or replay). Fail-closed reasons surface as a buffer diagnostic.
    void terminalApi
      .spawn({ tabId, cols, rows })
      .then((res) => {
        if (disposed) return;
        if (!res.ok) term.write(diagnostic(`[terminal unavailable] ${res.message}`));
      })
      .catch((err: unknown) => {
        if (!disposed) {
          term.write(diagnostic(`[terminal error] ${err instanceof Error ? err.message : String(err)}`));
        }
      });

    // Resize the PTY when the pane changes size.
    const resizeObserver = new ResizeObserver(() => {
      const dims = safeFit();
      void terminalApi.resize(tabId, dims.cols, dims.rows);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputSub.dispose();
      offData();
      offExit();
      term.dispose();
      // NOTE: PTY is intentionally NOT killed here — it survives unmount and is
      // torn down on tab close (closeWorkspaceTab → terminal.kill).
    };
  }, [api, tabId]);

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background"
      data-testid="chat-side-panel-pty-terminal"
    >
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />
    </div>
  );
}
