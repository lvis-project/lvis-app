const SAFE_PLUGIN_AUTH_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,80}$/;

function stringField(value: unknown, key: "code" | "error" | "message"): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : null;
}

export function sanitizePluginAuthErrorCode(value: string | null | undefined): string | null {
  if (!value) return null;
  const code = value.trim();
  return SAFE_PLUGIN_AUTH_ERROR_CODE.test(code) ? code : null;
}

/**
 * Derive a sanitized, safe-to-display error code from an arbitrary thrown
 * plugin-auth error. Prefers an explicit `code`/`error` string field, then
 * falls back to a `[BRACKETED]` code embedded in the message. Pure — no i18n
 * or React. Extracted from App.tsx (C14) for direct unit testing; App's
 * `formatPluginAuthLoginError` composes the user-facing string from this.
 */
export function extractPluginAuthErrorCode(err: unknown): string | null {
  const explicitCode =
    sanitizePluginAuthErrorCode(stringField(err, "code")) ??
    sanitizePluginAuthErrorCode(stringField(err, "error"));
  if (explicitCode) return explicitCode;

  const message =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : stringField(err, "message");
  const bracketCode = message?.match(/\[([A-Za-z0-9][A-Za-z0-9._:-]{0,80})\]/)?.[1];
  return sanitizePluginAuthErrorCode(bracketCode);
}
