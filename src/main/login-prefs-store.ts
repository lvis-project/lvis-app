/**
 * Login Prefs store — persists the user's chosen login screen variant.
 *
 * Storage namespace per feature (project CLAUDE.md): the file lives under
 * `~/.lvis/login-prefs/login-prefs.json` so the domain owns its own
 * directory rather than scattering a top-level file at `~/.lvis/`.
 *
 *   directory mode: 0o700
 *   file mode:      0o600
 *
 * The store is intentionally minimal — a single `loginVariant` string
 * literal. Future additions go in the same JSON object.
 *
 * Error contract: read returns the default on any failure (corrupt JSON,
 * missing file, permission denied). Write throws via `fs.promises.writeFile`
 * — callers handle the rejection.
 */
import { promises as fs, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { lvisHome } from "../shared/lvis-home.js";

export const LOGIN_VARIANTS = ["conversational", "cli-agent"] as const;
export type LoginVariant = (typeof LOGIN_VARIANTS)[number];

export interface LoginPrefs {
  loginVariant: LoginVariant;
}

export const DEFAULT_LOGIN_PREFS: LoginPrefs = {
  loginVariant: "conversational",
};

function isLoginVariant(value: unknown): value is LoginVariant {
  return typeof value === "string" && (LOGIN_VARIANTS as readonly string[]).includes(value);
}

function loginPrefsDir(): string {
  return join(lvisHome(), "login-prefs");
}

function loginPrefsPath(): string {
  return join(loginPrefsDir(), "login-prefs.json");
}

/**
 * Read the persisted login prefs. Any read/parse error falls back to the
 * default — this is a user-preference toggle, not a security boundary, so
 * a missing/corrupt file should never block the host from booting.
 */
export async function readLoginPrefs(): Promise<LoginPrefs> {
  try {
    const raw = await fs.readFile(loginPrefsPath(), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "loginVariant" in parsed) {
      const candidate = (parsed as { loginVariant: unknown }).loginVariant;
      if (isLoginVariant(candidate)) {
        return { loginVariant: candidate };
      }
    }
    return DEFAULT_LOGIN_PREFS;
  } catch {
    return DEFAULT_LOGIN_PREFS;
  }
}

/**
 * Persist the login prefs to disk. Creates the namespace directory with
 * 0o700 + writes the file with 0o600 to match the Storage Namespace per
 * Feature rule.
 */
export async function writeLoginPrefs(next: LoginPrefs): Promise<void> {
  if (!isLoginVariant(next.loginVariant)) {
    throw new Error("invalid-login-variant");
  }
  const dir = loginPrefsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort — pre-existing dir may already be 0o755 on some hosts */
  }
  const path = loginPrefsPath();
  await fs.writeFile(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.chmod(path, 0o600);
  } catch {
    /* file mode may already be correct; ignore */
  }
}
