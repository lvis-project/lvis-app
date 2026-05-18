/**
 * LoginModalConversational (Tutorial-A · L-X1) —
 *
 * Conversational login variant. The credential form is framed as a chat
 * turn: a system-line header, an assistant message that greets the user,
 * three "chip" choices (use demo / I have my own key / org SSO), a
 * 2-turn user/assistant follow-up after the demo chip click, a mono
 * checklist that types-on the auth progress, and a credential form.
 *
 * Mirrors the L-X1 mockup at `/tmp/login-lvis/index.html` while staying
 * inside the host theme tokens (bg-background / text-foreground / bg-muted
 * etc.) so the modal adapts to every bundle (tokyo-night, forest,
 * violet-*, …).
 *
 * F2 (Tutorial-Suite verification fix) — added pieces that were missing
 * from the original L-X1 ship:
 *   • User-side bubble after the demo chip is selected
 *     ("데모 자격증명으로 시작할게요")
 *   • Assistant follow-up bubble
 *     ("좋아요. 데모 자격증명으로 인증 중이에요…")
 *   • Mono `✓ 자격증명 검증 / ✓ LLM 키 발급 (anthropic) / ⟳ sandbox 준비 중…`
 *     checklist with a type-on progression and a blinking `▍` cursor.
 *   • Footer "위 선택지를 클릭하거나 `1`~`3` 키로 빠른 선택" + a real
 *     1/2/3 keydown handler that activates chip 1/2/3.
 *
 * Behavioural parity with the original LoginModal:
 *   - Calls `api.loginMockup(...)` over IPC.
 *   - The renderer translates kebab-case English `error` codes into the
 *     Korean user-facing message; the IPC handler must never embed
 *     Korean (project CLAUDE.md error-language rule).
 *   - The password is wiped in `finally` even on success/error so a
 *     transient failure cannot leave it visible on the next render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Type-on checklist lines for the auth progress. Rendered after the demo
 * chip is selected — the steps reveal one at a time with a short stagger
 * so the user reads them sequentially. The final `⟳` line shows a
 * blinking `▍` cursor while the form is still awaiting submission.
 */
const CHECKLIST_LINES: readonly { mark: string; label: string }[] = Object.freeze([
  { mark: "✓", label: "자격증명 검증" },
  { mark: "✓", label: "LLM 키 발급 (anthropic)" },
  { mark: "⟳", label: "sandbox 준비 중…" },
]);

/** Stagger between checklist line reveals (ms). */
const CHECKLIST_STAGGER_MS = 280;

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

  // F2 — 2-turn conversational flow that fires when the demo chip is
  // selected. `userTurnVisible` shows the user bubble, `assistantReply`
  // shows the assistant follow-up, `checklistRevealed` tracks how many
  // checklist lines have been typed on (0 = none, CHECKLIST_LINES.length
  // = all). All three reset whenever the dialog re-opens.
  const [userTurnVisible, setUserTurnVisible] = useState(false);
  const [assistantReply, setAssistantReply] = useState(false);
  const [checklistRevealed, setChecklistRevealed] = useState(0);
  const passwordRef = useRef<HTMLInputElement>(null);

  // Reset the conversational flow on every open so a re-entry starts
  // from the cold "어떤 방식으로 시작할까요?" prompt.
  useEffect(() => {
    if (open) {
      setUserTurnVisible(false);
      setAssistantReply(false);
      setChecklistRevealed(0);
    }
  }, [open]);

  // Drive the checklist reveal once the assistant reply has rendered.
  // Each line is staggered by CHECKLIST_STAGGER_MS so the user reads
  // them sequentially rather than seeing them appear all at once.
  useEffect(() => {
    if (!assistantReply) return;
    if (checklistRevealed >= CHECKLIST_LINES.length) return;
    const timer = window.setTimeout(() => {
      setChecklistRevealed((n) => n + 1);
    }, CHECKLIST_STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [assistantReply, checklistRevealed]);

  const activateDemoChip = useCallback(() => {
    setUserTurnVisible(true);
    // Defer the assistant reply by one tick so the user bubble paints
    // first — matches the mockup's "user types → assistant responds"
    // perceived ordering.
    window.setTimeout(() => {
      setAssistantReply(true);
      // Focus the password field so the next keystroke goes to the
      // credential input the user has to fill.
      passwordRef.current?.focus();
    }, 120);
  }, []);

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

  // F2 — 1/2/3 keybindings for chip activation. Mirrors the
  // "위 선택지를 클릭하거나 `1`~`3` 키로 빠른 선택" footer hint. We
  // only fire when the dialog is open and the keystroke is not part of
  // a text-input session (Input fields use type="text"/"password" — a
  // bare `1` would otherwise be eaten by the username field).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Don't hijack typing inside the credential inputs.
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        activateDemoChip();
      } else if (e.key === "2" || e.key === "3") {
        // chips 2 & 3 are disabled placeholders; the keystroke is
        // intentionally swallowed (no toast) so it does not bubble to
        // the wider App keyboard handlers.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, activateDemoChip]);

  const isLastChecklistLine =
    checklistRevealed > 0 && checklistRevealed <= CHECKLIST_LINES.length;
  const lastLineIsSpinner =
    isLastChecklistLine &&
    CHECKLIST_LINES[checklistRevealed - 1]?.mark === "⟳";

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
            directly on the next required input AND fires the 2-turn
            conversational flow (F2). */}
        <div className="pl-9 space-y-1.5">
          <button
            type="button"
            data-testid="login-modal:chip-demo"
            onClick={activateDemoChip}
            className="w-full rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left text-[12px] text-primary hover:bg-primary/15"
          >
            <span className="mr-1">⚡</span>
            <span className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary/15 px-1 text-[10px] font-semibold text-primary">
              1
            </span>
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
            <span className="mr-1">🔑</span>
            <span className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              2
            </span>
            제가 발급받은 API 키가 있어요
          </button>
          <button
            type="button"
            disabled
            data-testid="login-modal:chip-sso"
            className="w-full cursor-not-allowed rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-muted-foreground"
            title="조직 SSO 는 별도 구성이 필요합니다"
          >
            <span className="mr-1">🏢</span>
            <span className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              3
            </span>
            조직 SSO 로 연결
          </button>
        </div>

        {/* F2 — User-side bubble + assistant follow-up + type-on
            checklist. The blocks reveal only after the demo chip is
            selected so the cold-open mockup retains its original
            "어떤 방식으로 시작할까요?" framing. */}
        {userTurnVisible && (
          <div
            className="flex justify-end pt-2"
            data-testid="login-modal:user-turn"
          >
            <p className="rounded-lg rounded-tr-sm bg-primary/15 px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
              데모 자격증명으로 시작할게요.
            </p>
          </div>
        )}
        {assistantReply && (
          <div className="flex gap-2" data-testid="login-modal:assistant-reply">
            <div
              className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
              aria-hidden="true"
            >
              ✦
            </div>
            <div className="space-y-1.5">
              <p className="rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
                좋아요. 데모 자격증명으로 인증 중이에요…
              </p>
              {checklistRevealed > 0 && (
                <pre
                  data-testid="login-modal:auth-checklist"
                  className="rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-[11.5px] leading-[1.7] text-foreground"
                >
                  {CHECKLIST_LINES.slice(0, checklistRevealed).map((line, i) => {
                    const isLast = i === checklistRevealed - 1;
                    const isSpinner = line.mark === "⟳";
                    return (
                      <div key={line.label}>
                        <span
                          className={
                            isSpinner
                              ? "text-primary"
                              : "text-success"
                          }
                        >
                          {line.mark}
                        </span>{" "}
                        {line.label}
                        {isLast && lastLineIsSpinner ? (
                          <span
                            data-testid="login-modal:cursor"
                            className="ml-1 inline-block animate-pulse text-primary"
                            aria-hidden="true"
                          >
                            ▍
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </pre>
              )}
            </div>
          </div>
        )}

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
              ref={passwordRef}
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

        {/* F2 — Footer hint mirrors the mockup's
            "위 선택지를 클릭하거나 `1`~`3` 키로 빠른 선택" line. */}
        <p
          data-testid="login-modal:footer-hint"
          className="border-t border-border/60 pt-2 text-center text-[10.5px] text-muted-foreground"
        >
          위 선택지를 클릭하거나 <kbd className="rounded border border-border bg-muted px-1 font-mono">1</kbd>
          ~
          <kbd className="rounded border border-border bg-muted px-1 font-mono">3</kbd>
          {" "}키로 빠른 선택
        </p>
      </DialogContent>
    </Dialog>
  );
}
