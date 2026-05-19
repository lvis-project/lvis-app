/**
 * Live Auto-play — contract types.
 *
 * Demo-only. Shared between `ScriptedTurnEngine`, `FakeSandbox`,
 * `DemoAutoplayBanner`, and the per-script JSON fixtures under
 * `./scripts/<id>.json`. See
 * `docs/architecture/proposals/live-autoplay.md` §3 for the SOT contract.
 *
 * Invariant: types defined here never escape into `ConversationLoop`
 * or `tool-registry`. All consumers stay inside the renderer-local
 * autoplay surface so the demo trust boundary is enforceable at
 * import-time.
 */

/** Pre-recorded turn — fully self-contained, no LLM/tool runtime touched. */
export interface ScriptedTurn {
  /** Stable id (slug). Loaded from scripts/<id>.json. */
  id: string;
  /** Localized title shown in the REC indicator / audit prefix. */
  titleKo: string;
  /** Simulated user message — emitted with type-on animation. */
  userMessage: string;
  /** Tool call sequence — each call returns a sandboxed fake result. */
  toolCalls: ScriptedToolCall[];
  /** Final assistant response — emitted with type-on animation. */
  assistantResponse: string;
  /**
   * Type-on speed (ms / char). Default 25. Per-character delay keeps the
   * "user is typing" illusion consistent with the mockup cadence.
   */
  typeOnMsPerChar?: number;
}

export interface ScriptedToolCall {
  /**
   * Tool name (e.g. `meeting_list`). The string is *display only* — the
   * engine NEVER routes this through `tool-registry.ts`. Real tools never
   * see autoplay calls.
   */
  toolName: string;
  /** Korean label shown next to the tool name (mockup parity). */
  labelKo: string;
  /**
   * Pre-computed fake result — plain string only, no nested LLM JSON.
   * `fakeResultKo` is prefixed with `데모: ` at render time so the user can
   * never visually mistake it for a real tool result.
   */
  fakeResultKo: string;
  /** Optional delay before this call fires (ms). Default 600. */
  delayMs?: number;
}

/**
 * Reason a scripted turn ended. The engine reports the cause so
 * `auditLogger` and view-cleanup logic can branch.
 */
export type ScriptedAbortReason =
  | "user-takeover"
  | "user-input"
  | "external"
  | "completed";

/**
 * Sink the engine writes into. The ChatView-side implementation
 * accumulates entries with `kind: "demo-autoplay-*"` so they live in
 * a view-only history that never reaches `ConversationLoop`.
 */
export interface ScriptedSink {
  emitUserMessage(text: string, isFinal: boolean): void;
  emitToolCall(call: ScriptedToolCall, status: "running" | "done"): void;
  emitToolResult(call: ScriptedToolCall, resultKo: string): void;
  emitAssistantDelta(text: string, isFinal: boolean): void;
  /** Engine has stopped — sink should clear scripted entries from view. */
  onAborted(reason: ScriptedAbortReason): void;
}

/**
 * Activation gate inputs. Centralised so both the renderer entry decision
 * and any future main-process IPC use the same predicate.
 */
export interface DemoActivationInputs {
  /** `settings.features.demoAutoplayEnabled` */
  flagEnabled: boolean | undefined;
  /** `settings.features.onboardingCompleted` */
  onboardingCompleted: boolean | undefined;
  /** Whether `process.env.LVIS_DEMO_VENDOR` was set at boot. */
  demoVendorPresent: boolean;
}

/**
 * §7 of the proposal: activation predicate. Spelled out so the truth table
 * is testable in isolation.
 *
 * Intent: autoplay is a *returning-user re-engage* surface, NOT a first-run
 * onboarding path. On a fresh install the user MUST see the
 * `ScenarioShowcase` chain — autoplay activating before showcase mounts
 * causes the boot probe to flip the chain straight to `done` via
 * force-finish, producing the closet-flash regression that motivated
 * PR #1019 and this follow-up. Explicit `demoAutoplayEnabled = true` still
 * activates (developer / QA override path).
 *
 * Demo activates iff:
 *   (A) `LVIS_DEMO_VENDOR` is present
 *   AND
 *   (B) user did NOT explicitly opt out (`demoAutoplayEnabled === false`)
 *   AND
 *   (C) `onboardingCompleted === true` (returning user re-engage)
 *
 * Why fresh-state `flagEnabled === true` no longer trumps onboarding
 * (M2 fix, critic MAJOR finding 2026-05-19):
 *   A user with `demoAutoplayEnabled=true` set in settings.json but no
 *   `onboardingCompleted` flag (clean install carrying over a previous
 *   profile, or a QA snapshot) would otherwise activate demo while the
 *   Z chain reducer is sitting in stage="welcome"/"memory". The demo
 *   view paints over those dialogs and the chain never advances —
 *   `markOnboardingCompleted` never fires, so the next boot loops.
 *   Activating the explicit opt-in still requires the user to clear
 *   onboarding once; afterwards both `flagEnabled === true` and
 *   `onboardingCompleted === true` activate the demo.
 *
 * Resulting truth table (encoded for tests):
 *   flag=true    + completed=true  + vendor=true → activate (explicit enable, post-onboard)
 *   flag=true    + completed=false + vendor=true → skip (first-run → showcase)
 *   flag=true    + completed=undef + vendor=true → skip (first-run → showcase)
 *   flag=undef   + completed=true  + vendor=true → activate (returning user)
 *   flag=undef   + completed=false + vendor=true → skip (first-run → showcase)
 *   flag=undef   + completed=undef + vendor=true → skip (first-run → showcase)
 *   flag=false   + completed=*     + vendor=true → skip (explicit opt-out)
 *   *            + *               + vendor=false → skip (production dead path)
 */
export function shouldActivateDemoAutoplay(inputs: DemoActivationInputs): boolean {
  if (!inputs.demoVendorPresent) return false;
  if (inputs.flagEnabled === false) return false;
  // First-run gate: activate only when onboarding has explicitly completed.
  // Applies to BOTH explicit opt-in (`flagEnabled === true`) and the
  // returning-user implicit path. First-run users (onboardingCompleted false
  // or undefined) must see the ScenarioShowcase chain first — otherwise
  // the demo paints over the chain reducer and the chain stalls forever.
  return inputs.onboardingCompleted === true;
}
