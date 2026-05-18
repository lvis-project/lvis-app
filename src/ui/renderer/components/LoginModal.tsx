/**
 * LoginModal (#893 / Tutorial-A) — variant-aware wrapper.
 *
 * Reads the persisted login screen variant via `api.loginPrefsGet()` and
 * mounts one of:
 *   - LoginModalConversational (default — L-X1 chat-first mockup)
 *   - LoginModalCliAgent       (L-X2 terminal-styled mockup)
 *
 * Subscribes to `api.onLoginPrefsChanged` so a Settings toggle takes
 * effect immediately. When the variant changes while the modal is open,
 * the variant component remounts via the React `key` prop so per-variant
 * local state (form-visible, username, error) is reset cleanly rather
 * than carried across designs.
 *
 * `LoginMockupSuccess` + `LoginModalProps` are exported from this file so
 * both variant files share the exact same shape and so existing callers
 * (App.tsx, SettingsContent.tsx) keep working unchanged.
 *
 * IPC error contract: kebab-case English `error` codes flow through the
 * variants; the renderer translates to the Korean UI message — the host
 * IPC layer never embeds Korean text.
 */
import { useEffect, useState } from "react";
import type { LvisApi, LoginVariant } from "../types.js";
import { LoginModalConversational } from "./LoginModalConversational.js";
import { LoginModalCliAgent } from "./LoginModalCliAgent.js";

export interface LoginMockupSuccess {
  ok: true;
  vendor: string;
  model?: string;
  baseUrl?: string;
  vertexProject?: string;
  vertexLocation?: string;
  fieldsApplied: string[];
}

export interface LoginModalProps {
  api: LvisApi;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fires after the host confirms the demo key has been persisted. The
   * activated vendor is reported by the backend (top-level login decides
   * vendor) so the caller can refresh vendor-keyed UI state.
   */
  onSuccess?: (vendor: string, result: LoginMockupSuccess) => void;
}

const DEFAULT_VARIANT: LoginVariant = "conversational";

export function LoginModal(props: LoginModalProps) {
  const { api } = props;
  const [variant, setVariant] = useState<LoginVariant>(DEFAULT_VARIANT);

  // Load the persisted variant on mount. `loginPrefsGet` never rejects on
  // missing/corrupt storage — the host returns the default — so we don't
  // need a try/catch around the IPC call beyond the in-flight cancel guard.
  // `typeof === "function"` guards let test renderers stub a partial `api`
  // (e.g. ChatView/AppPluginAuth fixtures) without crashing the wrapper.
  useEffect(() => {
    if (typeof api.loginPrefsGet !== "function") return;
    let cancelled = false;
    void (async () => {
      try {
        const result = await api.loginPrefsGet();
        if (cancelled) return;
        if (result.ok) {
          setVariant(result.prefs.loginVariant);
        }
      } catch {
        // Read failures are best-effort — variant stays at the default.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  // Live update: when Settings flips the variant, every open window
  // receives `lvis:login-prefs:changed` and the modal re-renders with the
  // new variant immediately (no app restart).
  useEffect(() => {
    if (typeof api.onLoginPrefsChanged !== "function") return;
    return api.onLoginPrefsChanged((next) => {
      setVariant(next.loginVariant);
    });
  }, [api]);

  // `key` forces a remount when the variant flips so each variant's local
  // state (form-visible toggle, submitted flag, etc.) starts fresh.
  if (variant === "cli-agent") {
    return <LoginModalCliAgent key="cli-agent" {...props} />;
  }
  return <LoginModalConversational key="conversational" {...props} />;
}
