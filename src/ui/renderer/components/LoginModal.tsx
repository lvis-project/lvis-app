/**
 * LoginModal — re-exports `LoginModalConversational` under the canonical
 * `LoginModal` name.
 *
 * The L-X2 CLI Agent variant + persisted variant toggle were removed; the
 * Conversational variant is the single login surface. Existing callers
 * (App.tsx, SettingsContent.tsx) continue to import `LoginModal` /
 * `LoginModalProps` / `LoginMockupSuccess` from this module unchanged.
 */
import type { LvisApi } from "../types.js";
import { LoginModalConversational } from "./LoginModalConversational.js";

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



  forceActivation?: boolean;
}

export const LoginModal = LoginModalConversational;
