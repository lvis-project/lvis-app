



import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
const log = createLogger("policy-store");



const DEFAULT_USER_POLICY_PATH = resolve(lvisHome(), "policy.json");




export function getAdminPolicyPath(): string {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/LVIS/policy.json";
    case "win32":
      return join(process.env.ProgramData ?? "C:\\ProgramData", "LVIS", "policy.json");
    case "linux":
      return "/etc/lvis/policy.json";
    default:

      return "/nonexistent/lvis/policy.json";
  }
}



export interface PolicyFile {
  version: 1;

  requireExplicitApproval: boolean;

  managed: boolean;
  updatedAt: string;
}




export interface LoadedPolicy extends PolicyFile {

  source: "defaults" | "user" | "admin" | "merged";

  adminOverrides?: string[];

  adminPath?: string;
}



function defaultPolicy(): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
  };
}



const policyLocks = new Map<string, Promise<void>>();

async function withPolicyLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = resolve(filePath);
  const prev = policyLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  policyLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

// ─── Read (single file) ───────────────────────────────

async function readPolicyFile(filePath: string): Promise<PolicyFile | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PolicyFile;
    if (parsed.version !== 1) {

      log.error(`version mismatch in ${filePath}: expected 1, got ${parsed.version} — ignoring`);
      return null;
    }
    return parsed;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // JSON parse errors and similar read failures log and fall back.
    log.error(`failed to read ${filePath}: %s`, (err as Error).message);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────

/**
 * Load policy. When an admin-dir file exists, merge it with precedence over the user file.
 *
 * Returned `source` field:
 *  - "defaults": no file exists, so defaults are used
 *  - "user":     only the user file exists
 *  - "admin":    only the admin file exists
 *  - "merged":   both exist, with admin overriding user values
 *
 * @param userPath  User policy file path (default: ~/.lvis/policy.json)
 * @param adminPath Admin policy file path (default: getAdminPolicyPath())
 */
export async function loadPolicy(
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<LoadedPolicy> {
  const [userFile, adminFile] = await Promise.all([
    readPolicyFile(userPath),
    readPolicyFile(adminPath),
  ]);

  // case 1: neither exists, so use defaults.
  if (!userFile && !adminFile) {
    return { ...defaultPolicy(), source: "defaults" };
  }

  // case 2: only the user file exists.
  if (userFile && !adminFile) {
    return { ...userFile, source: "user" };
  }

  // case 3: only the admin file exists.
  if (!userFile && adminFile) {
    return { ...adminFile, source: "admin", adminPath };
  }

  // case 4: both exist, so merge with admin taking precedence.
  const base = { ...defaultPolicy(), ...userFile! };
  const overrides: string[] = [];
  const merged = { ...base };

  const adminFields = adminFile!;
  // requireExplicitApproval
  if (adminFields.requireExplicitApproval !== undefined &&
      adminFields.requireExplicitApproval !== base.requireExplicitApproval) {
    merged.requireExplicitApproval = adminFields.requireExplicitApproval;
    overrides.push("requireExplicitApproval");
  }
  // managed: admin true → always true
  if (adminFields.managed === true) {
    merged.managed = true;
    if (!base.managed) overrides.push("managed");
  }
  // updatedAt: use admin's timestamp when merged
  merged.updatedAt = adminFields.updatedAt;

  return {
    ...merged,
    version: 1,
    source: "merged",
    adminPath,
    adminOverrides: overrides,
  };
}

/**
 * Save policy to disk.
 *
 * Blocking conditions, in priority order:
 *  1. admin-dir file exists → always throw "Policy is managed by IT (admin-dir file exists)"
 *  2. user file managed: true → throw the localized managed-policy error
 *
 * The managed flag itself cannot be changed via patch; it belongs to the IT Admin API.
 */
export async function savePolicy(
  patch: Partial<Omit<PolicyFile, "version" | "managed" | "updatedAt">>,
  userPath = DEFAULT_USER_POLICY_PATH,
  adminPath = getAdminPolicyPath(),
): Promise<PolicyFile> {
  return withPolicyLock(userPath, async () => {
    // Check admin-dir first.
    const adminFile = await readPolicyFile(adminPath);
    if (adminFile !== null) {
      throw new Error("Policy is managed by IT (admin-dir file exists)");
    }

    const existing = await readPolicyFile(userPath);

    // Check user managed: true, preserving the existing B1 behavior.
    if (existing?.managed === true) {
      throw new Error(t("be_policyStore.managedPolicyUserCannotChange"));
    }

    const current = existing ?? defaultPolicy();
    const updated: PolicyFile = {
      ...current,
      ...patch,
      version: 1,
      managed: current.managed, // Users cannot change managed.
      updatedAt: new Date().toISOString(),
    };

    await mkdir(dirname(userPath), { recursive: true });
    // §S4: 0o600 — owner read/write only
    const fd = await open(userPath, "w", 0o600);
    try {
      await fd.writeFile(`${JSON.stringify(updated, null, 2)}\n`, "utf-8");
    } finally {
      await fd.close();
    }

    return updated;
  });
}
