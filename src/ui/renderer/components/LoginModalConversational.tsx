



import { useCallback, useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
} from "../../../components/ui/dialog.js";
import { Button } from "../../../components/ui/button.js";
import { OnboardingHeader } from "../onboarding/OnboardingCard.js";
import type { LoginModalProps } from "./LoginModal.js";
import { t } from "../../../i18n/runtime.js";

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
      return t("loginModalConversational.errInvalidCredentials");
    case "no-demo-key":
      // This should no longer fire for a valid activation: Azure Foundry
      // payloads require both API key and endpoint before persistence.
      // If it does fire, the captured demo payload is incomplete.
      return t("loginModalConversational.errNoDemoKey");
    // v0.2.1 hotfix — Step 2 (llm-key-issuing) try/catch surfaces this
    // when setSecret / patch fails (disk full, Keychain locked, etc.).
    // Without this branch the renderer fell through to the generic

    // fail had no actionable hint.
    case "llm-key-issuing-failed":
      return t("loginModalConversational.errLlmKeyIssuingFailed");
    case "reviewer-rewire-failed":
      return t("loginModalConversational.errReviewerRewireFailed");
    // v0.2.1 hotfix — Azure Foundry endpoint unreachable. Surfaces when
    // the host-resolver-rules first-activation race could not be healed
    // by relaunch (e.g. VPN/intranet not connected post-relaunch).
    case "endpoint-unreachable":
      return t("loginModalConversational.errEndpointUnreachable");
    case "invalid-foundry-endpoint":
      return t("loginModalConversational.errInvalidFoundryEndpoint");
    case "missing-foundry-host-map":
      return t("loginModalConversational.errMissingFoundryHostMap");
    case "foundry-host-map-mismatch":
      return t("loginModalConversational.errFoundryHostMapMismatch");
    case "invalid-foundry-host-map-target":
      return t("loginModalConversational.errInvalidFoundryHostMapTarget");
    default:
      return t("loginModalConversational.errLoginFailed");
  }
}

/**
 * Renderer-side translation of activation IPC error codes. Mirrors the
 * `errorMessage` contract above — IPC stays English (kebab-case), UI
 * surfaces Korean. The activation step has its own error surface because
 * the failure modes are distinct from auth: a bad code is a typo / wrong
 * paste rather than a wrong password.
 */
function activationErrorMessage(code: string): string {
  switch (code) {
    case "invalid-code":
      return t("loginModalConversational.activErrInvalidCode");
    case "no-embedded-code":
      return t("loginModalConversational.activErrNoEmbeddedKey");
    case "no-vendor":
      return t("loginModalConversational.activErrNoVendor");
    case "invalid-vendor":
      return t("loginModalConversational.activErrInvalidVendor");
    case "no-demo-key":
      return t("loginModalConversational.activErrNoDemoKey");
    case "missing-foundry-endpoint":
      return t("loginModalConversational.activErrMissingFoundryEndpoint");
    case "invalid-foundry-endpoint":
      return t("loginModalConversational.activErrInvalidFoundryEndpoint");
    case "missing-foundry-host-map":
      return t("loginModalConversational.activErrMissingFoundryHostMap");
    case "foundry-host-map-mismatch":
      return t("loginModalConversational.activErrFoundryHostMapMismatch");
    case "invalid-foundry-host-map-target":
      return t("loginModalConversational.activErrInvalidFoundryHostMapTarget");
    case "persist-failed":
      return t("loginModalConversational.activErrPersistFailed");
    case "unauthorized-frame":
      return t("loginModalConversational.activErrUnauthorizedFrame");
    default:
      return t("loginModalConversational.activErrActivationFailed");
  }
}

/**
 * #1498 — Ollama activation IPC error codes. Separate from
 * `activationErrorMessage` because the only failure mode is "the local
 * server that was reachable a moment ago is gone now" — a narrower surface
 * than the demo-key validation errors above.
 */
function ollamaErrorMessage(code: string): string {
  switch (code) {
    case "no-ollama":
      return t("loginModalConversational.activErrNoOllama");
    case "unauthorized-frame":
      return t("loginModalConversational.activErrUnauthorizedFrame");
    default:
      return t("loginModalConversational.activErrActivationFailed");
  }
}

/**
 * Type-on checklist lines for the auth progress (F2 fallback). Rendered
 * after the demo chip is selected when the live IPC progress is not yet
 * active — the steps reveal one at a time with a short stagger so the
 * user reads them sequentially. The final `⟳` line shows a blinking
 * `▍` cursor while the form is still awaiting submission.
 */
const CHECKLIST_LINES: readonly { mark: string; labelKey: string }[] = Object.freeze([
  { mark: "✓", labelKey: "loginModalConversational.checklistCredentials" },
  { mark: "✓", labelKey: "loginModalConversational.checklistLlmKey" },
  { mark: "⟳", labelKey: "loginModalConversational.checklistSandbox" },
]);

/**
 * Stagger between checklist line reveals (ms). Y1 (pace): increased from
 * 280ms → 720ms → 900ms so the user has enough dwell time to read each
 * line before the next one types on. The activation step ahead of the
 * checklist already added perceived load (~3–5s for paste + decrypt), so
 * the post-activation checklist needs longer per-line dwell to feel
 * deliberate rather than rushed. Korean reading speed ~250 wpm ≈
 * 600ms/short phrase; 900ms keeps the cursor visible on each line long
 * enough for an unhurried read.
 */
const CHECKLIST_STAGGER_MS = 900;




const SUCCESS_DWELL_MS = 1800;
const ACTIVATION_RELAUNCH_DWELL_MS = 5000;

export function LoginModalConversational({
  api,
  open,
  onOpenChange,
  onSuccess,
  forceActivation = false,
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
  // Y1 — flips true the moment loginMockup resolves OK. The trailing

  // so the user sees an explicit success state before the SUCCESS_DWELL_MS
  // window elapses and the modal closes.
  const [successConfirmed, setSuccessConfirmed] = useState(false);

  // Activation sub-state. The chip 1 click opens an inline activation
  // input rather than firing `loginMockup` directly. `activationOpen`
  // gates the input UI; `activationCode` is the user-typed string;
  // `activationError` carries the kebab-case → Korean translation when
  // decrypt/persist fails; `activating` blocks the submit button while
  // the IPC roundtrip is in flight. The whole sub-state resets when the
  // dialog re-opens so a cancelled flow starts from the cold prompt.
  //
  // Activation success either synchronously kicks off `runAuthMockup` or,
  // on first activation, holds a visible relaunch notice for 5s while the
  // main process relaunch contract remains armed behind IPC.
  const [activationOpen, setActivationOpen] = useState(false);
  const [activationCode, setActivationCode] = useState("");
  const [activationError, setActivationError] = useState<string | null>(null);
  const [activationNotice, setActivationNotice] = useState<string | null>(null);
  const [activating, setActivating] = useState(false);
  const [activationRelaunching, setActivationRelaunching] = useState(false);
  const [checkingDemoStatus, setCheckingDemoStatus] = useState(false);

  // #1498 — local Ollama fallback chip. `ollamaAvailable` gates whether the
  // chip renders at all (never shown when nothing answered the probe — an
  // unconditional CTA would be misleading). Probed once per modal open
  // alongside the demo-status check's own timing; `ollamaActivating` blocks
  // the chip while its own IPC roundtrip is in flight.
  const [ollamaAvailable, setOllamaAvailable] = useState(false);
  const [ollamaActivating, setOllamaActivating] = useState(false);

  // Reset the conversational flow on every open so a re-entry starts

  useEffect(() => {
    if (open) {
      setUserTurnVisible(false);
      setAssistantReply(false);
      setChecklistRevealed(0);
      setSuccessConfirmed(false);
      setError(null);
      setActivationOpen(false);
      setActivationCode("");
      setActivationError(null);
      setActivationNotice(null);
      setActivating(false);
      setActivationRelaunching(false);
      setOllamaAvailable(false);
      setOllamaActivating(false);
    }
  }, [open]);

  // #1498 — probe Ollama availability whenever the modal opens so the chip
  // stack reflects the current machine state without requiring the user to
  // click chip 1 first. A fresh probe every open (no caching) mirrors the
  // `demo.status()` freshness contract — the user may start/stop their
  // local Ollama server between app launches.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const status = await api.demo.status();
        if (!cancelled && status.ok) {
          setOllamaAvailable(status.ollamaAvailable);
        }
      } catch (err) {
        // Best-effort — a failed probe just keeps the chip hidden, it must
        // never surface as a login-blocking error.
        // eslint-disable-next-line no-console
        console.error("demo.status IPC failed (ollama probe)", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  useEffect(() => {
    if (!activationRelaunching) return;
    const timer = window.setTimeout(() => {
      void api.demo
        .relaunchAfterActivation()
        .then((result) => {
          if (result.ok) return;
          setActivationRelaunching(false);
          setActivationNotice(null);
          setActivationError(t("loginModalConversational.relaunchRequestFailed"));
        })
        .catch((err) => {
          setActivationRelaunching(false);
          setActivationNotice(null);
          setActivationError(t("loginModalConversational.relaunchRequestError"));
          // eslint-disable-next-line no-console
          console.error("demo.relaunchAfterActivation IPC failed", err);
        });
    }, ACTIVATION_RELAUNCH_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [api, activationRelaunching]);

  // Drive the checklist reveal only after activation has succeeded and
  // the auth IPC step has actually started. The assistant reply renders
  // earlier because it contains the activation textarea.
  useEffect(() => {
    if (!assistantReply) return;
    if (!submitting) return;
    if (checklistRevealed >= CHECKLIST_LINES.length) return;
    const timer = window.setTimeout(() => {
      setChecklistRevealed((n) => n + 1);
    }, CHECKLIST_STAGGER_MS);
    return () => window.clearTimeout(timer);
  }, [assistantReply, submitting, checklistRevealed]);

  /**
   * Run the existing loginMockup chain after activation has succeeded.
   * Factored out of the original `activateDemoChip` so the auth-step
   * pacing (checklist + dwell + onSuccess hand-off) lives in one place.
   * Called directly from `submitActivation` once the activation IPC
   * resolves OK — the earlier "press Enter to begin" interstitial was
   * removed 2026-05-19.
   */
  const runAuthMockup = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setChecklistRevealed(0);
    setSuccessConfirmed(false);
    // Once auth starts, collapse the inline activation input and let the
    // checklist take over the same assistant transcript lane.
    setActivationOpen(false);
    try {
      const result = await api.loginMockup({
        username: DEMO_USERNAME,
        password: DEMO_PASSWORD,
      });
      if (result.ok) {
        // Y1 — flip the trailing spinner line to a ✓ confirmation
        // (state lives in `successConfirmed`), then dwell so the user

        setSuccessConfirmed(true);
        await new Promise<void>((resolve) =>
          window.setTimeout(resolve, SUCCESS_DWELL_MS),
        );
        onSuccess?.(result.vendor, result);
        onOpenChange(false);
        return;
      }
      setError(errorMessage(result.error));
    } catch (err) {
      setError(t("loginModalConversational.errLoginProcessError"));
      // eslint-disable-next-line no-console
      console.error("loginMockup IPC failed", err);
    } finally {
      setSubmitting(false);
    }
  }, [api, onSuccess, onOpenChange, submitting]);

  /**
   * Embedded activation — the build carries an activation key
   * (`status.autoActivatable`), so the chip click runs the same
   * decrypt→validate→persist chain as `submitActivation` with no paste
   * input. Success follows the manual contract exactly: first activation
   * arms the relaunch notice, otherwise the auth transcript starts.
   * Failure (stale embedded key after a passphrase rotation, disk error)
   * surfaces the activation error AND opens the manual input so the flow
   * never dead-ends — the user can still paste a fresh key from their
   * administrator.
   */
  const runEmbeddedActivation = useCallback(async () => {
    if (activating || submitting || activationRelaunching) return;
    setActivating(true);
    setActivationError(null);
    setActivationNotice(null);
    try {
      const result = await api.demo.activateEmbedded();
      if (result.ok) {
        if (result.requiresRelaunch) {
          setActivationNotice(t("loginModalConversational.activationRelaunchNotice"));
          setActivationRelaunching(true);
          return;
        }
        void runAuthMockup();
        return;
      }
      setActivationError(activationErrorMessage(result.error));
      setActivationOpen(true);
    } catch (err) {
      setActivationError(t("loginModalConversational.activErrProcessError"));
      setActivationOpen(true);
      // eslint-disable-next-line no-console
      console.error("demo.activateEmbedded IPC failed", err);
    } finally {
      setActivating(false);
    }
  }, [api, activating, submitting, activationRelaunching, runAuthMockup]);

  /**
   * #1498 — local Ollama fallback chip. No credentials, no activation-key
   * paste, no relaunch: the vendor is configured directly (preset baseUrl +
   * default model + `hasApiKey` gate placeholder) and, on success, hands
   * off to `onSuccess` exactly like a completed login. Re-probes inside
   * the IPC handler itself, so a server the user stopped between opening
   * the modal and clicking the chip fails closed with `no-ollama` instead
   * of silently configuring a dead endpoint.
   */
  const activateOllamaChip = useCallback(async () => {
    if (ollamaActivating || submitting || activating || activationRelaunching) return;
    setError(null);
    setOllamaActivating(true);
    try {
      const result = await api.demo.activateOllama();
      if (result.ok) {
        onSuccess?.(result.vendor, {
          ok: true,
          vendor: result.vendor,
          fieldsApplied: ["apiKey", "baseUrl", "model"],
        });
        onOpenChange(false);
        return;
      }
      setError(ollamaErrorMessage(result.error));
    } catch (err) {
      setError(t("loginModalConversational.activErrProcessError"));
      // eslint-disable-next-line no-console
      console.error("demo.activateOllama IPC failed", err);
    } finally {
      setOllamaActivating(false);
    }
  }, [api, ollamaActivating, submitting, activating, activationRelaunching, onSuccess, onOpenChange]);

  /**
   * Demo chip handler. Fresh installs open the activation-input sub-state;
   * subsequent launches with `.env.demo` already loaded at boot ask the main
   * process for captured demo status and run the auth transcript immediately.
   * The renderer intentionally does not infer this from `window.lvis.env`:
   * packaged builds scrub `LVIS_DEMO_*` before preload inherits env.
   */
  const activateDemoChip = useCallback(() => {
    if (submitting || activating || activationRelaunching || checkingDemoStatus) {
      return;
    }
    setError(null);
    setActivationError(null);
    setActivationNotice(null);
    setUserTurnVisible(true);
    setActivationCode("");
    setActivationOpen(false);
    setCheckingDemoStatus(true);
    // Defer the assistant reply by one tick so the user bubble paints
    // first — matches the mockup's "user types → assistant responds"
    // perceived ordering.
    window.setTimeout(() => {
      setAssistantReply(true);
    }, 220);
    void (async () => {
      try {
        const status = await api.demo.status();
        if (!status.ok) {
          setError(activationErrorMessage(status.error));
          return;
        }
        if (status.activated && !forceActivation) {
          window.setTimeout(() => {
            void runAuthMockup();
          }, 220);
          return;
        }
        if (status.autoActivatable && !forceActivation) {
          // Embedded activation key — skip the paste input entirely.

          // path so the user can supply a *different* key than the one
          // embedded in this build.
          window.setTimeout(() => {
            void runEmbeddedActivation();
          }, 220);
          return;
        }
        setActivationOpen(true);
      } catch (err) {
        setError(t("loginModalConversational.errDemoStatusCheckError"));
        // eslint-disable-next-line no-console
        console.error("demo.status IPC failed", err);
      } finally {
        setCheckingDemoStatus(false);
      }
    })();
  }, [
    submitting,
    activating,
    activationRelaunching,
    checkingDemoStatus,
    forceActivation,
    api,
    runAuthMockup,
    runEmbeddedActivation,
  ]);

  /**
   * Submit the activation code. First activation persists `.env.demo`,
   * shows the 5s relaunch notice, and lets the armed IPC restart apply the
   * new host resolver env. If no relaunch is required, the auth transcript
   * starts immediately via `runAuthMockup`. Failure paints a chat-style
   * error bubble inside the activation block and leaves the input editable
   * for retry.
   */
  const submitActivation = useCallback(async () => {
    if (activating || submitting || activationRelaunching) return;
    const trimmed = activationCode.trim();
    if (trimmed.length === 0) {
      setActivationError(activationErrorMessage("invalid-code"));
      return;
    }
    setActivating(true);
    setActivationError(null);
    setActivationNotice(null);
    try {
      const result = await api.demo.activate(trimmed);
      if (result.ok) {
        if (result.requiresRelaunch) {
          setActivationNotice(t("loginModalConversational.activationRelaunchNotice"));
          setActivationRelaunching(true);
          return;
        }
        // Chain straight into the auth transcript — no extra Enter press
        // required. `runAuthMockup` flips `submitting` true on entry, which
        // collapses the activation block (gated by `!submitting`) and lets
        // the checklist take over the same visual lane.
        void runAuthMockup();
        return;
      }
      setActivationError(activationErrorMessage(result.error));
    } catch (err) {
      setActivationError(t("loginModalConversational.activErrProcessError"));
      // eslint-disable-next-line no-console
      console.error("demo.activate IPC failed", err);
    } finally {
      setActivating(false);
    }
  }, [api, activationCode, activating, submitting, activationRelaunching, runAuthMockup]);



  const forceActivationFiredRef = useRef(false);
  useEffect(() => {
    if (!open) {
      forceActivationFiredRef.current = false;
      return;
    }
    if (!forceActivation) return;
    if (forceActivationFiredRef.current) return;
    forceActivationFiredRef.current = true;
    activateDemoChip();
  }, [open, forceActivation, activateDemoChip]);

  // F2 — 1/2/3 keybindings for chip activation. Mirrors the

  // Note (2026-05-20): the previous F5 "Enter to proceed" shortcut was
  // removed. First activation relaunches after the 5s notice; later boots
  // enter auth directly from chip 1 with no second user keystroke.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isInputTarget =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      // Don't hijack typing inside any incidental inputs (Settings tab
      // navigation chip may briefly hand focus to a child input, and the
      // activation textarea wires its own Enter handler).
      if (isInputTarget) {
        return;
      }
      if (e.key === "1") {
        e.preventDefault();
        activateDemoChip();
      } else if (e.key === "2") {
        e.preventDefault();
        void api.openSettingsWindow?.("llm");
        onOpenChange(false);
      } else if (e.key === "3") {
        // chip 3 is a disabled placeholder; swallow the keystroke so it
        // does not bubble to the wider App keyboard handlers.
        e.preventDefault();
      } else if (e.key === "4" && ollamaAvailable) {
        // #1498 — chip 4 only exists (and only responds to the keystroke)
        // when the Ollama probe found a local server.
        e.preventDefault();
        void activateOllamaChip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, activateDemoChip, api, onOpenChange, ollamaAvailable, activateOllamaChip]);

  const isLastChecklistLine =
    checklistRevealed > 0 && checklistRevealed <= CHECKLIST_LINES.length;
  const lastLineIsSpinner =
    isLastChecklistLine &&
    CHECKLIST_LINES[checklistRevealed - 1]?.mark === "⟳";
  const handleDialogOpenChange = useCallback((next: boolean) => {
    if (activationRelaunching && !next) return;


    if (!next && !forceActivation) return;
    onOpenChange(next);
  }, [activationRelaunching, forceActivation, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogContent
        size="sm"
        data-testid="login-modal"
        data-variant="conversational"
        className="p-0 overflow-hidden"
      >
        {/* E7 — common look-and-feel (Warp login reference): a centered
            brand wordmark header (shared OnboardingHeader scaffold used by
            every other onboarding chain surface) over a single-column,
            minimal-copy body with stacked full-width CTAs. The former
            chat-transcript chrome (system status row + assistant/user
            bubbles) is folded into the shared surface tokens so the modal
            reads as one member of the onboarding family rather than a
            bespoke screen. Flow + IPC are unchanged. */}
        <OnboardingHeader
          size="lg"
          title={t("loginModalConversational.dialogTitle")}
          description={t("loginModalConversational.sessionStart")}
        />

        <div className="px-6 pb-6 space-y-4">
          {/* Intro line — big-headline + minimal-copy hierarchy. */}
          <p
            data-testid="login-modal:greeting"
            className="text-[12.5px] leading-relaxed text-muted-foreground"
          >
            {t("loginModalConversational.greeting")}{" "}
            {t("loginModalConversational.greetingPrompt")}
          </p>

        {/* Chip choices — three options. Chip 1 opens the inline activation
            input; chip 2 navigates to Settings → LLM tab; chip 3 is a
            disabled placeholder. The user never types a password — the
            demo credentials are hard-coded in the renderer + IPC handler.
            Rendered as a vertical stack of full-width CTAs (Warp reference:
            single-accent emphasis on the primary path). */}
        <div className="space-y-2" data-testid="login-modal:chips">
          <button
            type="button"
            data-testid="login-modal:chip-demo"
            onClick={() => activateDemoChip()}
            disabled={
              submitting ||
              activating ||
              activationRelaunching ||
              checkingDemoStatus ||
              activationOpen
            }
            className="flex w-full items-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-left text-[12px] font-medium text-primary-foreground shadow-e1 transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            <span aria-hidden="true">⚡</span>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-primary-foreground/(--opacity-light) px-1 text-[10px] font-semibold text-primary-foreground">
              1
            </span>
            <span className="min-w-0 flex-1">
              {t("loginModalConversational.chip1Label")}
              <span className="ml-1.5 text-[10px] font-normal text-primary-foreground/(--opacity-stronger)">
                {t("loginModalConversational.chip1Sub")}
              </span>
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
            disabled={submitting || activationRelaunching}
            className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-secondary px-3 py-2.5 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted disabled:opacity-60"
          >
            <span aria-hidden="true">🔑</span>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              2
            </span>
            <span className="min-w-0 flex-1">
              {t("loginModalConversational.chip2Label")}
              <span className="ml-1.5 text-[10px] text-muted-foreground">
                {t("loginModalConversational.chip2Sub")}
              </span>
            </span>
          </button>
          <button
            type="button"
            disabled
            data-testid="login-modal:chip-sso"
            className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg border border-border-subtle bg-secondary/(--opacity-half) px-3 py-2.5 text-left text-[12px] text-muted-foreground"
            title={t("loginModalConversational.chip3Title")}
          >
            <span aria-hidden="true">🏢</span>
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
              3
            </span>
            <span className="min-w-0 flex-1">
              {t("loginModalConversational.chip3Label")}
              <span className="ml-1.5 text-[10px]">
                {t("loginModalConversational.chip3Sub")}
              </span>
            </span>
          </button>
          {/* #1498 — Ollama local-model fallback. Only rendered when the
              main-process probe confirmed a local server is actually
              reachable (`ollamaAvailable`) — never shown unconditionally,
              since an always-visible CTA that then fails would mislead
              off-network / no-key users into thinking local models are
              always available. */}
          {ollamaAvailable && (
            <button
              type="button"
              data-testid="login-modal:chip-ollama"
              onClick={() => void activateOllamaChip()}
              disabled={
                submitting ||
                activating ||
                activationRelaunching ||
                checkingDemoStatus ||
                activationOpen ||
                ollamaActivating
              }
              className="flex w-full items-center gap-2 rounded-lg border border-border-subtle bg-secondary px-3 py-2.5 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted disabled:opacity-60"
            >
              <span aria-hidden="true">🖥️</span>
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
                4
              </span>
              <span className="min-w-0 flex-1">
                {ollamaActivating
                  ? t("loginModalConversational.chipOllamaActivating")
                  : t("loginModalConversational.chipOllamaLabel")}
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {t("loginModalConversational.chipOllamaSub")}
                </span>
              </span>
            </button>
          )}
        </div>

        {/* F2 — User-side bubble + assistant follow-up + type-on
            checklist. The blocks reveal only after the demo chip is
            selected so the cold-open mockup retains its original
            start-method framing. Y2 — slide-up fade-in
            keyframes (`lvis-anim-slide-up`) make the conversational
            turns land smoothly instead of popping. */}
        {userTurnVisible && (
          <div
            className="flex justify-end pt-2 lvis-anim-slide-up"
            data-testid="login-modal:user-turn"
          >
            <p className="rounded-lg rounded-tr-sm bg-primary/(--opacity-soft) px-3 py-2 text-[12.5px] leading-relaxed text-foreground">
              {t("loginModalConversational.userTurnText")}
            </p>
          </div>
        )}
        {assistantReply && (
          <div
            className="flex gap-2 lvis-anim-slide-up"
            data-testid="login-modal:assistant-reply"
          >
            <div
              className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
              aria-hidden="true"
            >
              ✦
            </div>
            <div className="space-y-1.5">
              <p
                className="rounded-lg rounded-tl-sm bg-muted px-3 py-2 text-[12.5px] leading-relaxed text-foreground"
                data-testid="login-modal:assistant-prompt"
              >
                {submitting
                  ? t("loginModalConversational.assistantSubmitting")
                  : activationRelaunching
                    ? t("loginModalConversational.assistantRelaunching")
                    : checkingDemoStatus
                      ? t("loginModalConversational.assistantCheckingStatus")
                      : activating && !activationOpen
                        ? t("loginModalConversational.assistantEmbeddedActivating")
                        : t("loginModalConversational.assistantPromptActivation")}
              </p>

              {activationOpen && !submitting && (
                <div
                  data-testid="login-modal:activation-input"
                  className="space-y-1.5"
                >
                  <textarea
                    autoFocus
                    value={activationCode}
                    onChange={(ev) => setActivationCode(ev.target.value)}
                    onKeyDown={(ev) => {
                      if (
                        ev.key === "Enter" &&
                        !ev.shiftKey &&
                        !ev.nativeEvent.isComposing
                      ) {
                        ev.preventDefault();
                        void submitActivation();
                      }
                    }}
                    disabled={activating || activationRelaunching}
                    rows={2}
                    placeholder="LVIS-DEMO:v1:..."
                    aria-label={t("loginModalConversational.activationInputAriaLabel")}
                    data-testid="login-modal:activation-code-input"
                    className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[11.5px] leading-snug text-foreground placeholder:text-muted-foreground/(--opacity-strong) focus:outline-none focus:ring-2 focus:ring-primary/(--opacity-medium) disabled:opacity-60"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      data-testid="login-modal:activation-submit"
                      onClick={() => void submitActivation()}
                      disabled={
                        activating ||
                        activationRelaunching ||
                        activationCode.trim().length === 0
                      }
                    >
                      {activationRelaunching
                        ? t("loginModalConversational.btnWaitingRelaunch")
                        : activating
                          ? t("loginModalConversational.btnActivating")
                          : t("loginModalConversational.btnActivate")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-testid="login-modal:activation-cancel"
                      onClick={() => {
                        setActivationOpen(false);
                        setActivationCode("");
                        setActivationError(null);
                        setActivationNotice(null);
                        setUserTurnVisible(false);
                        setAssistantReply(false);
                      }}
                      disabled={activating || activationRelaunching}
                    >
                      {t("loginModalConversational.btnCancel")}
                    </Button>
                  </div>
                  {activationError && (
                    <p
                      data-testid="login-modal:activation-error"
                      role="alert"
                      className="rounded-md bg-destructive/(--opacity-subtle) px-2 py-1.5 text-[11.5px] leading-relaxed text-destructive"
                    >
                      {activationError}
                    </p>
                  )}
                  {activationNotice && (
                    <p
                      data-testid="login-modal:activation-notice"
                      role="status"
                      className="rounded-md bg-success/(--opacity-subtle) px-2 py-1.5 text-[11.5px] leading-relaxed text-success"
                    >
                      {activationNotice}
                    </p>
                  )}
                </div>
              )}

              {checklistRevealed > 0 && (
                <pre
                  data-testid="login-modal:auth-checklist"
                  className="rounded-md border border-border bg-background/(--opacity-strong) px-3 py-2 font-mono text-[11.5px] leading-[1.7] text-foreground"
                >
                  {CHECKLIST_LINES.slice(0, checklistRevealed).map((line, i) => {
                    const isLast = i === checklistRevealed - 1;
                    const isSpinner = line.mark === "⟳";
                    // Y1 — once success is confirmed, flip the trailing

                    // so the user gets an explicit success cue during the
                    // SUCCESS_DWELL_MS window before the modal hands off.
                    const isFinalSpinner = isSpinner && isLast;
                    const mark =
                      isFinalSpinner && successConfirmed ? "✓" : line.mark;
                    const label =
                      isFinalSpinner && successConfirmed
                        ? t("loginModalConversational.checklistSandboxDone")
                        : t(line.labelKey);
                    const isCheckmark =
                      mark === "✓" || (isFinalSpinner && successConfirmed);
                    return (
                      <div
                        key={line.labelKey}
                        // Y3 — fade-in each newly-revealed checklist line
                        // so the cursor visually "carries" from row to
                        // row instead of resetting with each reveal. Uses
                        // the shared `lvis-anim-slide-up` keyframe so
                        // prefers-reduced-motion collapses it to an opacity
                        // fade automatically (see src/styles.css §290).
                        className="lvis-anim-slide-up"
                      >
                        <span
                          className={
                            isCheckmark ? "text-success" : "text-primary"
                          }
                        >
                          {mark}
                        </span>{" "}
                        {label}
                        {isLast && lastLineIsSpinner && !successConfirmed ? (
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
              className="rounded-lg rounded-tl-sm bg-destructive/(--opacity-subtle) px-3 py-2 text-[12.5px] leading-relaxed text-destructive"
              role="alert"
            >
              {error}
            </p>
          </div>
        )}

        {/* 2026-05-20: Cancel footer button removed — 1/2/3 forced choice.
            The user MUST pick one of the chips (or the disabled SSO
            placeholder); there is no path to dismiss the modal without
            advancing. Status text for in-flight auth/relaunch surfaces
            inline via the chip disabled state + assistant bubble copy. */}

          {/* F2 — Footer hint mirrors the mockup's quick-choice instruction. */}
          <p
            data-testid="login-modal:footer-hint"
            className="border-t border-border-subtle pt-3 text-center text-[10.5px] text-muted-foreground"
          >
            {t("loginModalConversational.footerHintPre")}<kbd className="rounded border border-border bg-muted px-1 font-mono">1</kbd>
            ~
            <kbd className="rounded border border-border bg-muted px-1 font-mono">{ollamaAvailable ? "4" : "3"}</kbd>
            {t("loginModalConversational.footerHintPost")}
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
