/**
 * LoginModalConversational (Tutorial-A · L-X1) —
 *
 * Conversational login variant. The credential form is framed as a chat
 * turn: a system-line header, an assistant message that greets the user,
 * three "chip" choices (use demo / I have my own key / org SSO), and a
 * credential form. This mirrors the L-X1 mockup at
 * `/tmp/login-lvis/index.html` while staying inside the host theme
 * tokens (bg-background / text-foreground / bg-muted etc.) so the modal
 * adapts to every bundle (tokyo-night, forest, violet-*, …).
 *
 * Behavioural parity with the original LoginModal:
 *   - Calls `api.loginMockup(...)` over IPC.
 *   - The renderer translates kebab-case English `error` codes into the
 *     Korean user-facing message; the IPC handler must never embed
 *     Korean (project CLAUDE.md error-language rule).
 *   - The password is wiped in `finally` even on success/error so a
 *     transient failure cannot leave it visible on the next render.
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

export function LoginModalConversational({
  api,
  open,
  onOpenChange,
  onSuccess,
}: LoginModalProps) {
  // Form is always mounted so callers (and existing playwright/unit
  // tests) can reach `data-testid="login-modal:username"` without
  // synthesising a chip click. The chips above the form provide the
  // L-X1 conversational framing (intent disambiguation) without
  // gating access to the credential inputs.
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
      <DialogContent size="sm" data-testid="login-modal" data-variant="conversational">
        <DialogHeader>
          <DialogTitle>LVIS — Welcome</DialogTitle>
        </DialogHeader>

        {/* System line — quiet status row that frames the modal as a
            chat session rather than a credential form. Uses the
            success token so it adapts to every bundle. */}
        <div className="flex items-center gap-2 border-b border-border/60 pb-2 text-[11px] text-muted-foreground">
          <span className="inline-block size-1.5 rounded-full bg-success" aria-hidden="true" />
          <span>LVIS · 인증 세션 시작</span>
        </div>

        {/* Assistant message — greeting + intent disambiguation. */}
        <div className="flex gap-2 pt-2">
          <div
            className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
            aria-hidden="true"
          >
            ✦
          </div>
          <div className="space-y-1.5">
            <p className="rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
              안녕하세요. <br />
              LVIS 는 처음이시군요. 어떤 방식으로 시작할까요?
            </p>
          </div>
        </div>

        {/* Chip choices — informational links above the credential form.
            "데모 자격증명" focuses the password field so the user lands
            directly on the next required input. */}
        <div className="pl-9 space-y-1.5">
          <button
            type="button"
            data-testid="login-modal:chip-demo"
            onClick={() => {
              const pw = document.getElementById(
                "login-password-conv",
              ) as HTMLInputElement | null;
              pw?.focus();
            }}
            className="w-full rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left text-[12px] text-primary hover:bg-primary/15"
          >
            <span className="mr-1">⚡</span>
            데모 자격증명으로 30초 안에 체험
            <span className="ml-2 text-[10px] text-muted-foreground">
              자동 인증 · LLM 키 자동 발급
            </span>
          </button>
          <button
            type="button"
            disabled
            data-testid="login-modal:chip-byok"
            className="w-full cursor-not-allowed rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-muted-foreground"
            title="설정 → 모델에서 API 키를 직접 입력하세요"
          >
            <span className="mr-1">🔑</span>제가 발급받은 API 키가 있어요
          </button>
          <button
            type="button"
            disabled
            data-testid="login-modal:chip-sso"
            className="w-full cursor-not-allowed rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-muted-foreground"
            title="조직 SSO 는 별도 구성이 필요합니다"
          >
            <span className="mr-1">🏢</span>조직 SSO 로 연결
          </button>
        </div>

        <form
          className="space-y-3 pt-3"
          onSubmit={handleSubmit}
          data-testid="login-modal:form"
        >
          <div className="space-y-1">
            <Label htmlFor="login-username-conv">아이디</Label>
            <Input
              id="login-username-conv"
              data-testid="login-modal:username"
              autoComplete="username"
              value={username}
              onChange={(ev) => setUsername(ev.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="login-password-conv">비밀번호</Label>
            <Input
              id="login-password-conv"
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
          <div className="flex justify-end gap-2 pt-1">
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
              disabled={
                submitting || username.length === 0 || password.length === 0
              }
            >
              {submitting ? "확인 중…" : "로그인"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
