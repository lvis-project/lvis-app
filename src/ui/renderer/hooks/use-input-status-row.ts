import { useEffect, useState } from "react";
import type { LvisApi } from "../types.js";
import { shortVendorLabel } from "./status-bar/vendor-label.js";

/**
 * In-bar status sub-row data.
 *
 * The persistent model / permission / active-state cells that used to live in
 * the window StatusBar now render as a compact single line at the bottom of the
 * unified InputActionBar (the window StatusBar is notifications-only). This hook
 * resolves those fields from the same IPC the old StatusBar producers used —
 * `getSettings()` (+ `onSettingsUpdated`) for vendor/model and
 * `window.lvis.permission` (`getMode` + `onModeChanged`) for the policy mode —
 * but returns plain values instead of upserting StatusBar items.
 *
 * Render-loop guard (the #1312 lesson): the effects depend only on the stable
 * `api` reference, never on caller-built closures. The subscription callbacks
 * mutate local `useState` with primitive values, so an identical re-resolve
 * settles to the same state and React bails out — no upsert→new-array→re-render
 * cycle is possible here.
 */
export type PermissionModeVariant =
  | "default"
  | "strict"
  | "auto"
  | "allow"
  | "unknown";

export interface InputStatusRow {
  /** True once a model is configured — drives the green "active" dot. */
  active: boolean;
  /** "OpenAI · gpt-5.4" style label (vendor · model), or vendor alone. */
  vendorModel: string;
  /** Permission policy mode for per-mode text color + label. */
  permissionMode: PermissionModeVariant;
  /** Pending deferred-approval count (appended to the permission cell). */
  pendingApprovals: number;
}

function normalizeMode(raw: string): PermissionModeVariant {
  if (raw === "default" || raw === "strict" || raw === "auto" || raw === "allow") return raw;
  return "unknown";
}

export function useInputStatusRow(api: LvisApi): InputStatusRow {
  const [vendorModel, setVendorModel] = useState("");
  const [active, setActive] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionModeVariant>("unknown");
  const [pendingApprovals, setPendingApprovals] = useState(0);

  // Vendor + model — mirrors use-status-bar-vendor.
  useEffect(() => {
    if (typeof api.getSettings !== "function") return;
    let cancelled = false;

    const apply = (settings: Awaited<ReturnType<LvisApi["getSettings"]>>) => {
      if (cancelled) return;
      const provider = settings.llm?.provider ?? "";
      const model = settings.llm?.vendors?.[provider]?.model ?? "";
      const vendorLabel = shortVendorLabel(provider);
      setVendorModel(model.length > 0 ? `${vendorLabel} · ${model}` : vendorLabel);
      setActive(model.length > 0);
    };

    void api.getSettings().then(apply).catch(() => {
      // Awareness-only — leave the prior value on transient read failure.
    });

    const unsubs: Array<() => void> = [];
    if (typeof api.onSettingsUpdated === "function") {
      unsubs.push(api.onSettingsUpdated((next) => apply(next)));
    }
    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api]);

  // Permission mode + pending approvals — mirrors use-status-bar-permission.
  useEffect(() => {
    const perm = api.permission;
    if (!perm) return;
    let cancelled = false;

    void (async () => {
      try {
        const r = await perm.getMode();
        if (!cancelled) setPermissionMode(normalizeMode(r.mode));
      } catch {
        if (!cancelled) setPermissionMode("unknown");
      }
    })();

    void (async () => {
      try {
        const result = await perm.deferredList?.();
        if (!cancelled && result?.ok) setPendingApprovals(result.pending?.length ?? 0);
      } catch {
        if (!cancelled) setPendingApprovals(0);
      }
    })();

    const unsubs: Array<() => void> = [];
    const offMode = perm.onModeChanged?.((next) => setPermissionMode(normalizeMode(next)));
    if (offMode) unsubs.push(offMode);
    const offPending = perm.onDeferredPending?.((summary) =>
      setPendingApprovals(Math.max(0, summary.pending)),
    );
    if (offPending) unsubs.push(offPending);

    return () => {
      cancelled = true;
      for (const u of unsubs) u();
    };
  }, [api]);

  return { active, vendorModel, permissionMode, pendingApprovals };
}
