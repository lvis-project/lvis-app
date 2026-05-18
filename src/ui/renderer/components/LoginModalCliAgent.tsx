/**
 * LoginModalCliAgent (Tutorial-A · L-X2) —
 *
 * CLI Agent login variant. Replaces the chat-first framing with a
 * terminal transcript that frames LVIS as an agent on the user's
 * machine: a leading `$ lvis auth init` banner, environment checks,
 * and a `lvis auth login --profile demo` prompt that runs the same
 * `api.loginMockup(...)` IPC the conversational variant uses.
 *
 * Theme-token discipline (theme-snapshot test):
 *   - No raw Tailwind palette utilities (no `bg-slate-*`, `text-violet-*`).
 *   - Terminal aesthetic is composed of `bg-card`, `bg-muted`, `font-mono`,
 *     and the existing semantic tokens (success / primary / destructive),
 *     so the modal still adapts to every bundle (tokyo-night / forest / …).
 *
 * Shape parity with `LoginModalConversational`:
 *   - Same `LoginModalProps` (api, open, onOpenChange, onSuccess).
 *   - Same `data-testid="login-modal:submit"` / `:username` / `:password`
 *     / `:error` selectors so existing playwright + unit tests work
 *     against either variant once the wrapper exposes them.
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
import type { LoginModalProps } from "./LoginModal.js";

function errorMessage(code: string): string {
  switch (code) {
    case "invalid-credentials":
      return "아이디 또는 비밀번호가 올바르지 않습니다.";
    case "no-demo-key":
      return "데모 API 키가 환경 변수에 설정되어 있지 않습니다.";
    default:
      return "로그인에 실패했습니다.";
  }
}

export function LoginModalCliAgent({
  api,
  open,
  onOpenChange,
  onSuccess,
}: LoginModalProps) {
  const [username, setUsername] = useState("demo");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.loginMockup({ username, password });
      if (result.ok) {
        onSuccess?.(result.vendor, result);
        onOpenChange(false);
        setUsername("demo");
        return;
      }
      setError(errorMessage(result.error));
    } catch (err) {
      setError("로그인 처리 중 오류가 발생했습니다.");
      // eslint-disable-next-line no-console
      console.error("loginMockup IPC failed", err);
    } finally {
      setSubmitting(false);
      setPassword("");
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        data-testid="login-modal"
        data-variant="cli-agent"
        // Terminal aesthetic via semantic tokens: bg-card + font-mono. The
        // default shadcn DialogContent styling still owns the modal chrome
        // (rounded edges, max-width, focus trap).
        className="bg-card font-mono"
      >
        <DialogHeader>
          <DialogTitle className="text-primary">
            ✦ LVIS Agent <span className="text-muted-foreground">— auth</span>
          </DialogTitle>
        </DialogHeader>

        {/* Transcript header — frames the modal as a running shell. The
            output is decorative; the real IPC fires on submit below. */}
        <div className="space-y-0.5 border-y border-border py-2 text-[12px] leading-[1.7]">
          <div>
            <span className="text-primary">$</span> lvis auth init
          </div>
          <div className="pl-3 text-muted-foreground">› checking environment…</div>
          <div className="pl-3">
            <span className="text-success">✓</span> sandbox ready
          </div>
          <div className="pl-3">
            <span className="text-success">✓</span> Keychain available
          </div>
          <div className="pl-3">
            <span className="text-success">✓</span> demo profile detected
          </div>
          <div className="pt-2">
            <span className="text-primary">$</span> lvis auth login{" "}
            <span className="text-primary">--profile demo</span>
          </div>
        </div>

        <form className="space-y-2 pt-2" onSubmit={handleSubmit}>
          <div className="space-y-1">
            <Label
              htmlFor="login-username-cli"
              className="text-muted-foreground"
            >
              user:
            </Label>
            <Input
              id="login-username-cli"
              data-testid="login-modal:username"
              autoComplete="username"
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
              disabled={submitting}
              className="font-mono"
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor="login-password-cli"
              className="text-muted-foreground"
            >
              password:
            </Label>
            <Input
              id="login-password-cli"
              data-testid="login-modal:password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              disabled={submitting}
              className="font-mono"
            />
          </div>
          {error && (
            <p
              data-testid="login-modal:error"
              className="rounded border-l-2 border-destructive bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
              role="alert"
            >
              [ERR] {error}
            </p>
          )}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted-foreground">
              {submitting ? "› authenticating…" : "↵ Enter 키로 인증 실행"}
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onOpenChange(false)}
                disabled={submitting}
              >
                ⎋ 취소
              </Button>
              <Button
                type="submit"
                size="sm"
                data-testid="login-modal:submit"
                disabled={
                  submitting || username.length === 0 || password.length === 0
                }
              >
                {submitting ? "확인 중…" : "↵ 로그인"}
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
