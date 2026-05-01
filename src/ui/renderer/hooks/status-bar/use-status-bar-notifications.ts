import { useEffect } from "react";
import type { LvisApi } from "../../types.js";
import type { StatusBarSeverity, NotificationToastMeta } from "./types.js";

interface Options {
  api: LvisApi;
  pushToast: (input: {
    severity: StatusBarSeverity;
    message: string;
    ttlMs?: number;
    notification?: NotificationToastMeta;
  }) => string;
}

const TOAST_FIELD_MAX = 120;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
function safeField(input: unknown, max: number = TOAST_FIELD_MAX): string {
  return String(input ?? "unknown").replace(CONTROL_CHARS, "").slice(0, max);
}

export function useStatusBarNotifications({ api, pushToast }: Options): void {
  useEffect(() => {
    if (typeof api.onNotificationToast !== "function") return;
    const unsub = api.onNotificationToast((p) => {
      const severity: StatusBarSeverity =
        p.kind === "approval"
          ? "warning"
          : p.kind === "ask-user"
            ? "info"
            : p.kind === "routine"
              ? "success"
              : "info";
      pushToast({
        severity,
        message: `${safeField(p.title, 64)}: ${safeField(p.body, 80)}`,
        ttlMs: p.kind === "approval" ? 10_000 : 5_000,
        notification: { kind: p.kind, contextRef: p.contextRef },
      });
    });
    return () => {
      unsub();
    };
  }, [api, pushToast]);
}
