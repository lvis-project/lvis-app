import { win32 } from "node:path";

const LVIS_PROTOCOL = "lvis";
const LVIS_PROTOCOL_URL = "lvis://";

export interface WindowsProtocolRegistrationApi {
  getApplicationInfoForProtocol: (
    url: string,
  ) => Promise<{ path?: unknown } | null | undefined>;
  setAsDefaultProtocolClient: (protocol: string) => boolean;
}

function stripExtendedWindowsPathPrefix(value: string): string {
  const lower = value.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) {
    return "\\\\" + value.slice(8);
  }
  if (lower.startsWith("\\\\?\\")) {
    return value.slice(4);
  }
  return value;
}

function normalizeAbsoluteWindowsPath(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0")
  ) {
    return null;
  }

  const withoutExtendedPrefix = stripExtendedWindowsPathPrefix(value);
  if (!win32.isAbsolute(withoutExtendedPrefix)) {
    return null;
  }

  const normalized = win32.normalize(withoutExtendedPrefix);
  if (!/^[a-z]:\\$/i.test(win32.parse(normalized).root)) {
    return null;
  }

  return normalized.toLowerCase();
}

/**
 * Windows protocol lookup paths are case-insensitive and may use slash
 * separators or a local extended-length prefix. Accept drive-root paths only
 * and compare lexically so an untrusted HKCU association cannot trigger
 * filesystem or network I/O during startup.
 */
export function isSameWindowsExecutablePath(
  left: unknown,
  right: unknown,
): boolean {
  const normalizedLeft = normalizeAbsoluteWindowsPath(left);
  const normalizedRight = normalizeAbsoluteWindowsPath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

/**
 * Only packaged Windows builds need an asynchronous HKCR lookup. Development
 * registrations and packaged macOS/Linux registrations retain their existing
 * synchronous startup behavior.
 */
export function shouldDeferPackagedWindowsProtocolRegistration(
  isPackaged: boolean,
  platform: NodeJS.Platform,
): boolean {
  return isPackaged && platform === "win32";
}

/**
 * A per-machine NSIS install already owns lvis:// through HKLM. Electron's
 * setAsDefaultProtocolClient always writes HKCU on Windows, so call it only
 * when Windows does not currently resolve the protocol to this exact binary.
 * Every lookup/setter failure is soft: callers can warn without logging raw
 * association paths and still continue primary-instance startup.
 */
export async function ensurePackagedWindowsLvisProtocolClient(
  api: WindowsProtocolRegistrationApi,
  currentExecutable: string,
): Promise<boolean> {
  try {
    const application =
      await api.getApplicationInfoForProtocol(LVIS_PROTOCOL_URL);
    if (isSameWindowsExecutablePath(application?.path, currentExecutable)) {
      return true;
    }
  } catch {
    // Missing/unreadable associations fall back to Electron's normal HKCU registration.
  }

  try {
    return api.setAsDefaultProtocolClient(LVIS_PROTOCOL);
  } catch {
    return false;
  }
}
