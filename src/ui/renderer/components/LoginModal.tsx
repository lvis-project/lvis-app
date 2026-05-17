/**
 * LoginModal (#893) — mockup credential entry for the active LLM vendor.
 *
 * Calls `api.loginMockup(...)` over IPC. On success the host has already
 * installed the demo API key into the encrypted secret store; the parent is
 * responsible for refreshing its `hasKey(vendor)` snapshot via `onSuccess`.
 *
 * IPC error contract: kebab-case English codes (`invalid-credentials`,
 * `invalid-vendor`, `no-demo-key`). This component translates the code into
 * a Korean user-facing message; the IPC handler must never embed Korean.
 */
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import type { LvisApi } from "../types.js";

export interface LoginModalProps {
  api: LvisApi;
  vendor: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fires after the host confirms the demo key has been persisted. */
  onSuccess?: (vendor: string) => void;
}

function errorMessage(code: string): string {
  switch (code) {
    case "invalid-credentials":
      return "아이디 또는 비밀번호가 올바르지 않습니다.";
    case "invalid-vendor":
      return "지원하지 않는 벤더입니다.";
    case "no-demo-key":
      return "이 벤더의 데모 API 키가 환경 변수에 설정되어 있지 않습니다.";
    default:
      return "로그인에 실패했습니다.";
  }
}

export function LoginModal({ api, vendor, open, onOpenChange, onSuccess }: LoginModalProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    // PR #894 T1-1 — `api.loginMockup` is an IPC call; if the renderer
    // process loses the main-process channel (worker crash, preload
    // teardown), the promise rejects rather than resolving with
    // `{ ok: false, ... }`. Without a try/catch the rejection bubbles into
    // React as an unhandled promise rejection, `setSubmitting(false)`
    // never fires, and the modal stays disabled forever. The finally
    // block also clears the password so a transient error never leaves a
    // typed password visible on the next render (T1-1 / L1 cleanup).
    try {
      const result = await api.loginMockup({ username, password, vendor });
      if (result.ok) {
        onSuccess?.(vendor);
        onOpenChange(false);
        setUsername("");
        return;
      }
      setError(errorMessage(result.error));
    } catch (err) {
      setError("로그인 처리 중 오류가 발생했습니다.");
      // Surface IPC failure detail for forensic logs without leaking it to
      // the user-facing error string. The renderer's console is preload-
      // gated; this never traverses an IPC channel.
      // eslint-disable-next-line no-console
      console.error("loginMockup IPC failed", err);
    } finally {
      setSubmitting(false);
      setPassword("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm" data-testid="login-modal">
        <DialogHeader>
          <DialogTitle>로그인</DialogTitle>
        </DialogHeader>
        <form className="space-y-3 pt-2" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label htmlFor="login-username">아이디</Label>
            <Input
              id="login-username"
              data-testid="login-modal:username"
              autoComplete="username"
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="login-password">비밀번호</Label>
            <Input
              id="login-password"
              data-testid="login-modal:password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              disabled={submitting}
            />
          </div>
          {error && (
            <p
              data-testid="login-modal:error"
              className="text-xs text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              취소
            </Button>
            <Button
              type="submit"
              size="sm"
              data-testid="login-modal:submit"
              disabled={submitting || username.length === 0 || password.length === 0}
            >
              {submitting ? "확인 중…" : "로그인"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
