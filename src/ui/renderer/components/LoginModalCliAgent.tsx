/**
 * LoginModalCliAgent (Tutorial-A · L-X2) —
 *
 * CLI Agent login variant. Replaces the chat-first framing with a
 * terminal transcript that frames LVIS as an agent on the user's
 * machine: a leading `$ lvis auth init` banner, environment checks,
 * a `lvis auth login --profile demo` cached-credential transcript,
 * a success block, a `lvis chat new` trailing prompt with a blinking
 * `▍` cursor, and a footer with `↵ Enter chat` / `⎋ Use form login`.
 *
 * Mockup SoT: L-X2 (`/tmp/login-lvis/index.html`).
 *
 * F3 (Tutorial-Suite verification fix) — added pieces that were missing
 * from the original L-X2 ship:
 *   • The 4 mono result lines for `lvis auth login --profile demo`
 *     (`› using cached credentials`, `user: demo`, `vendor: anthropic`,
 *     `scope: chat · tools · sandbox`).
 *   • `[OK] authenticated as demo` success box (green left-border +
 *     `session expires in 7d · refreshable`).
 *   • The trailing `$ lvis chat new` line with a blinking `▍` cursor
 *     drawn via `animation: blink 1s steps(2) infinite` keyframes
 *     declared inline.
 *   • Footer `↵ Enter chat` + `⎋ Use form login` two-button row +
 *     `— powered by you` mono trailer.
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

/**
 * F3 — inline keyframes for the blinking `▍` cursor. We declare the
 * `@keyframes blink` rule via a single `<style>` injection so the
 * component does not need to mutate the global stylesheet bundle.
 * `prefers-reduced-motion: reduce` collapses the animation to a static
 * cursor so vestibular users do not see the blink.
 */
const CURSOR_KEYFRAMES = `
@keyframes lvis-login-cli-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .lvis-login-cli-cursor { animation: none !important; opacity: 1 !important; }
}
`;

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
  // F3 — `formMode` flips the modal between the L-X2 transcript view
  // (default — shows the mockup-faithful cached-credential output) and
  // the credential-form view (revealed by `⎋ Use form login`). The form
  // view is still mounted under the transcript so existing tests can
  // reach `data-testid="login-modal:username"` without flipping mode.
  const [showForm, setShowForm] = useState(false);

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

  /**
   * F3 — `↵ Enter chat` button. Submits the demo credentials directly,
   * bypassing the form view. The user only sees the form view when
   * they explicitly opt out via `⎋ Use form login`.
   */
  async function handleEnterChat() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.loginMockup({
        username: "demo",
        password: "demo123",
      });
      if (result.ok) {
        onSuccess?.(result.vendor, result);
        onOpenChange(false);
        return;
      }
      setError(errorMessage(result.error));
      // Fallback to the form view so the user can adjust credentials
      // when the cached path fails.
      setShowForm(true);
    } catch (err) {
      setError("로그인 처리 중 오류가 발생했습니다.");
      // eslint-disable-next-line no-console
      console.error("loginMockup IPC failed", err);
      setShowForm(true);
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
        {/* F3 — inline keyframes for the blinking `▍` cursor. */}
        <style dangerouslySetInnerHTML={{ __html: CURSOR_KEYFRAMES }} />
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
          {/* F3 — 4 mono result lines for the cached-credential path. */}
          <div
            className="pl-3 text-muted-foreground"
            data-testid="login-modal:cli-cached"
          >
            › using cached credentials
          </div>
          <div className="pl-3">
            <span className="text-muted-foreground">user:</span> demo
          </div>
          <div className="pl-3">
            <span className="text-muted-foreground">vendor:</span> anthropic
          </div>
          <div className="pl-3">
            <span className="text-muted-foreground">scope:</span> chat · tools · sandbox
          </div>
        </div>

        {/* F3 — `[OK] authenticated as demo` success box with the
            green left-border + session-expiry hint. */}
        <div
          data-testid="login-modal:cli-success"
          className="mt-2 rounded border-l-2 border-success bg-success/10 px-3 py-2 text-[12px]"
        >
          <div>
            <span className="text-success">[OK]</span>{" "}
            authenticated as <span className="text-foreground">demo</span>
          </div>
          <div className="text-[10.5px] text-muted-foreground">
            session expires in 7d · refreshable
          </div>
        </div>

        {/* F3 — Trailing `$ lvis chat new` line with the blinking
            `▍` cursor. Mirrors the mockup's "fresh shell ready" trailer. */}
        <div className="pt-1 text-[12px] leading-[1.7]">
          <span className="text-primary">$</span> lvis chat new{" "}
          <span
            data-testid="login-modal:cli-cursor"
            className="lvis-login-cli-cursor inline-block text-primary"
            style={{
              animation: "lvis-login-cli-blink 1s steps(2) infinite",
            }}
            aria-hidden="true"
          >
            ▍
          </span>
        </div>

        {/* Optional credential form — revealed only when the user opts
            out via `⎋ Use form login`. The form is always rendered in
            the DOM (with `hidden` toggling visibility) so existing
            playwright/unit tests can reach the inputs without first
            flipping the mode. */}
        <form
          className={`space-y-2 pt-2 ${showForm ? "" : "hidden"}`}
          onSubmit={handleSubmit}
          data-testid="login-modal:form"
        >
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
                onClick={() => setShowForm(false)}
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

        {/* F3 — Surface IPC errors at the transcript level when the
            form view is hidden, so the user sees `Enter chat` failure
            output without first opening the form. */}
        {!showForm && error && (
          <p
            data-testid="login-modal:error-transcript"
            className="rounded border-l-2 border-destructive bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
            role="alert"
          >
            [ERR] {error}
          </p>
        )}

        {/* F3 — Footer row with `↵ Enter chat` / `⎋ Use form login`
            two-button cluster + the `— powered by you` mono trailer. */}
        {!showForm && (
          <div
            data-testid="login-modal:cli-footer"
            className="flex items-center justify-between border-t border-border pt-3"
          >
            <span className="text-[10.5px] text-muted-foreground">
              — powered by you
            </span>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="login-modal:cli-use-form"
                onClick={() => setShowForm(true)}
                disabled={submitting}
              >
                ⎋ Use form login
              </Button>
              <Button
                type="button"
                size="sm"
                data-testid="login-modal:cli-enter-chat"
                onClick={() => void handleEnterChat()}
                disabled={submitting}
              >
                {submitting ? "› authenticating…" : "↵ Enter chat"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
