/**
 * LoginModalConversational (Tutorial-A · L-X1) —
 *
 * Conversational login. The credential form is *removed* entirely (Path 2
 * hotfix 2026-05-19): the modal is a pure chip-driven choice surface.
 *
 *   chip 1 — 데모 자격증명으로 30초 안에 체험
 *            Auto-invokes `api.loginMockup({ username: "demo",
 *            password: "demo123" })` — the demo username/password are
 *            hard-coded mockup credentials (matching `DEFAULT_DEMO_USER`
 *            / `DEFAULT_DEMO_PASS` in `ipc/domains/auth.ts`). The user
 *            never sees, types, or sets a password.
 *   chip 2 — 제가 발급받은 API 키가 있어요
 *            Opens Settings → LLM tab via `openSettingsWindow("llm")`.
 *   chip 3 — 조직 SSO (disabled placeholder, "곧 지원 예정").
 *
 * Behavioural parity with the original LoginModal:
 *   - Calls `api.loginMockup(...)` over IPC.
 *   - The renderer translates kebab-case English `error` codes into the
 *     Korean user-facing message; the IPC handler must never embed
 *     Korean (project CLAUDE.md error-language rule).
 *
 * Mirrors the L-X1 mockup at `/tmp/login-lvis/index.html` while staying
 * inside the host theme tokens (bg-background / text-foreground / bg-muted
 * etc.) so the modal adapts to every bundle (tokyo-night, forest,
 * violet-*, …).
 */
import { useCallback, useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { Button } from "../../../components/ui/button.js";
import type { LoginModalProps } from "./LoginModal.js";

/**
 * Hard-coded demo credentials. Match `DEFAULT_DEMO_USER` / `DEFAULT_DEMO_PASS`
 * in `src/ipc/domains/auth.ts`. The renderer-side constants exist so the
 * chip can auto-submit without ever exposing a text input.
 */
const DEMO_USERNAME = "demo";
const DEMO_PASSWORD = "demo123";

function errorMessage(code: string): string {
  switch (code) {
    case "invalid-credentials":
      return "데모 자격증명이 올바르지 않습니다.";
    case "no-demo-key":
      // F3 — Path 3 hotfix: this should no longer fire for the LGE
      // azure-foundry demo loop (baked-in creds now wired). If it does
      // fire, the user is on a non-azure-foundry vendor without env keys.
      return "데모 모드 설정 확인이 필요해요. 환경 변수 `LVIS_DEMO_VENDOR=azure-foundry` 를 설정한 뒤 다시 시도하세요. (docs/onboarding/local-demo-setup.md 참조)";
    case "reviewer-rewire-failed":
      return "에이전트 sandbox 초기화에 실패했습니다. 다시 시도해 주세요.";
    default:
      return "로그인에 실패했습니다.";
  }
}

/**
 * Type-on checklist lines for the auth progress (F2 fallback). Rendered
 * after the demo chip is selected when the live IPC progress is not yet
 * active — the steps reveal one at a time with a short stagger so the
 * user reads them sequentially. The final `⟳` line shows a blinking
 * `▍` cursor while the form is still awaiting submission.
 */
const CHECKLIST_LINES: readonly { mark: string; label: string }[] = Object.freeze([
  { mark: "✓", label: "자격증명 검증" },
  { mark: "✓", label: "LLM 키 발급 (azure-foundry)" },
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

  // Reset the conversational flow on every open so a re-entry starts
  // from the cold "어떤 방식으로 시작할까요?" prompt.
  useEffect(() => {
    if (open) {
      setUserTurnVisible(false);
      setAssistantReply(false);
      setChecklistRevealed(0);
      setError(null);
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

  /**
   * Demo chip handler — fires `loginMockup` with the hard-coded demo
   * credentials directly. The user never types a password; the chip
   * IS the submit. Errors surface in the inline error region.
   */
  const activateDemoChip = useCallback(async () => {
    if (submitting) return;
    setUserTurnVisible(true);
    setError(null);
    // Defer the assistant reply by one tick so the user bubble paints
    // first — matches the mockup's "user types → assistant responds"
    // perceived ordering.
    window.setTimeout(() => {
      setAssistantReply(true);
    }, 120);

    setSubmitting(true);
    try {
      const result = await api.loginMockup({
        username: DEMO_USERNAME,
        password: DEMO_PASSWORD,
      });
      if (result.ok) {
        onSuccess?.(result.vendor, result);
        onOpenChange(false);
        return;
      }
      setError(errorMessage(result.error));
    } catch (err) {
      setError("로그인 처리 중 오류가 발생했습니다.");
      // eslint-disable-next-line no-console
      console.error("loginMockup IPC failed", err);
    } finally {
      setSubmitting(false);
    }
  }, [api, onSuccess, onOpenChange, submitting]);

  // F2 — 1/2/3 keybindings for chip activation. Mirrors the
  // "위 선택지를 클릭하거나 `1`~`3` 키로 빠른 선택" footer hint.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      // Don't hijack typing inside any incidental inputs (Settings tab
      // navigation chip may briefly hand focus to a child input).
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
        void activateDemoChip();
      } else if (e.key === "2") {
        e.preventDefault();
        void api.openSettingsWindow?.("llm");
        onOpenChange(false);
      } else if (e.key === "3") {
        // chip 3 is a disabled placeholder; swallow the keystroke so it
        // does not bubble to the wider App keyboard handlers.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, activateDemoChip, api, onOpenChange]);

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

        {/* Chip choices — three options, no inline form. Path 2 hotfix:
            chip 1 auto-fires loginMockup; chip 2 navigates to Settings →
            LLM tab; chip 3 is a disabled placeholder. The user never
            types a password — the demo credentials are hard-coded in the
            renderer + IPC handler. */}
        <div className="pl-9 space-y-1.5 pt-1" data-testid="login-modal:chips">
          <button
            type="button"
            data-testid="login-modal:chip-demo"
            onClick={() => void activateDemoChip()}
            disabled={submitting}
            className="w-full rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-left text-[12px] text-primary hover:bg-primary/15 disabled:opacity-60"
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
            data-testid="login-modal:chip-byok"
            onClick={() => {
              // Open the canonical API-key editor (Settings → LLM tab).
              // The host's `openSettingsWindow` handler validates the tab
              // id and falls back to the default tab if unknown, so we
              // can pass the string directly without sanitising here.
              void api.openSettingsWindow?.("llm");
              onOpenChange(false);
            }}
            disabled={submitting}
            className="w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-foreground hover:bg-muted/60 disabled:opacity-60"
          >
            <span className="mr-1">🔑</span>
            <span className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              2
            </span>
            제가 발급받은 API 키가 있어요
            <span className="ml-2 text-[10px] text-muted-foreground">
              설정 → LLM 탭에서 입력
            </span>
          </button>
          <button
            type="button"
            disabled
            data-testid="login-modal:chip-sso"
            className="w-full cursor-not-allowed rounded-lg border border-border bg-muted/40 px-3 py-2 text-left text-[12px] text-muted-foreground"
            title="조직 SSO 연결은 곧 지원 예정입니다"
          >
            <span className="mr-1">🏢</span>
            <span className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              3
            </span>
            조직 SSO 로 연결
            <span className="ml-2 text-[10px] text-muted-foreground">
              곧 지원 예정
            </span>
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

        {/* Path 3 hotfix — the previous "real IPC progress checklist"
            (✓✗·· ul rendered below the transcript bubble) duplicated the
            type-on checklist already painted inside the assistantReply
            bubble above. Path 2 missed this when removing the form. The
            canonical surface is the type-on block inside the transcript
            bubble; IPC progress events still flow through `useAuthProgress`
            so future surfaces (e.g. a status badge) can subscribe without
            re-introducing the duplicate widget. */}

        {/* Inline error region — surfaces inside the assistant bubble
            stream as a follow-up message so the user reads the failure in
            the same visual lane as the type-on checklist (no separate
            widget). Covers no-demo-key, invalid-credentials,
            reviewer-rewire-failed, and transient IPC rejection. The error
            is renderer-translated; the IPC payload only carries kebab-case
            English codes. */}
        {error && (
          <div className="flex gap-2 pt-1" data-testid="login-modal:error-bubble">
            <div
              className="grid size-7 shrink-0 place-items-center rounded-md bg-destructive text-[11px] text-destructive-foreground"
              aria-hidden="true"
            >
              !
            </div>
            <p
              data-testid="login-modal:error"
              className="rounded-lg rounded-tl-sm bg-destructive/10 px-3 py-2 text-[12.5px] leading-relaxed text-destructive"
              role="alert"
            >
              {error}
            </p>
          </div>
        )}

        {/* Cancel-only footer button — there is no submit, the chips ARE
            the submit. Cancel closes the modal without authenticating. */}
        <div className="flex justify-end gap-2 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
            data-testid="login-modal:cancel"
          >
            {submitting ? "인증 중…" : "취소"}
          </Button>
        </div>

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
