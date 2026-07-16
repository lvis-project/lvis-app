import { isIP } from "node:net";

const NON_PUBLIC_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "test",
  "invalid",
  "example",
  "onion",
  "localdomain",
  "lan",
  "home",
  "corp",
] as const;

function isDnsHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) =>
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

/** Canonical public-looking HTTPS origin; address eligibility remains a DNS/health responsibility. */
export function isCanonicalA2APublicHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:"
      && !url.port
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && url.pathname === "/"
      && url.toString() === value
      && !hostname.endsWith(".")
      && isIP(hostname) === 0
      && isDnsHostname(hostname)
      && !NON_PUBLIC_SUFFIXES.some((suffix) =>
        hostname === suffix || hostname.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}
