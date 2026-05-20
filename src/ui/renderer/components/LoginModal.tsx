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
  /**
   * 2026-05-20 — Settings 의 "데모 자격증명 재입력" entry. `true` 면 chip 1/2/3
   * 선택 surface 를 건너뛰고 곧바로 activation 입력 페이지를 mount 한다.
   * `false` (기본) 면 기존 1/2/3 forced-choice 화면. 첫 부팅 onboarding
   * chain 은 항상 `false` 로 mount.
   */
  forceActivation?: boolean;
}

export const LoginModal = LoginModalConversational;
