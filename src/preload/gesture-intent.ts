// gesture-intent.ts — the SINGLE shared home of the user-keyboard gesture-intent
// token machinery (#1409 + #1411 C11).
//
// SECURITY-SENSITIVE: this is the trust gate for mutating IPC. Both preload
// surfaces import from HERE so there is exactly ONE `userKeyboardIntentTokens`
// map: the public surface MINTS tokens (`captureUserKeyboardIntent`) and
// CONSUMES them (`consumeUserKeyboardIntent`, from chatSend); the internal
// surface reports live activation (`ipcUserKeyboardIntent`) on the gesture-gated
// permission/policy/sandbox-install calls. If the two surfaces owned separate
// maps the gate would silently break, so the map + all helpers are defined
// exactly once, here.
import { randomUUID } from "node:crypto";
import type {
  UserKeyboardIntent,
  UserKeyboardIntentSnapshot,
} from "../shared/chat-origin.js";

function hasActiveUserGesture(): boolean {
  return globalThis.navigator?.userActivation?.isActive === true;
}

export const USER_KEYBOARD_INTENT_TTL_MS = 5_000;
export const userKeyboardIntentTokens = new Map<string, number>();

function pruneExpiredUserKeyboardIntents(now = Date.now()): void {
  for (const [token, expiresAt] of userKeyboardIntentTokens) {
    if (expiresAt <= now) userKeyboardIntentTokens.delete(token);
  }
}

export function captureUserKeyboardIntent(): UserKeyboardIntentSnapshot {
  if (!hasActiveUserGesture()) {
    return { inputOrigin: "user-keyboard", token: "" };
  }
  const now = Date.now();
  pruneExpiredUserKeyboardIntents(now);
  const token = randomUUID();
  userKeyboardIntentTokens.set(token, now + USER_KEYBOARD_INTENT_TTL_MS);
  return { inputOrigin: "user-keyboard", token };
}

export function consumeUserKeyboardIntent(userIntent?: UserKeyboardIntentSnapshot): boolean {
  const activeGesture = hasActiveUserGesture();
  if (userIntent && userIntent.inputOrigin === "user-keyboard" && typeof userIntent.token === "string") {
    const expiresAt = userKeyboardIntentTokens.get(userIntent.token);
    userKeyboardIntentTokens.delete(userIntent.token);
    if (typeof expiresAt === "number" && expiresAt > Date.now()) return true;
  }
  return activeGesture;
}

export function ipcUserKeyboardIntent(): UserKeyboardIntent | { inputOrigin: "user-keyboard"; userActivation: false } {
  return {
    inputOrigin: "user-keyboard",
    userActivation: hasActiveUserGesture(),
  };
}
