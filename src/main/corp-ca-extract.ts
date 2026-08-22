/**
 * Per-platform acquisition of the corporate root CA, by common name.
 *
 * Why this exists at all: Electron has two independent TLS stacks. Chromium's
 * network stack already trusts whatever the OS trusts, so pages load; Node's
 * does NOT — undici and `node:https` verify against the roots compiled into
 * Node. Every model call, marketplace fetch, and update check goes through the
 * Node side. On a machine behind a TLS-inspecting corporate proxy those all
 * fail while the browser half looks fine, which is exactly the confusing
 * half-broken state this module removes.
 *
 * macOS reads the System keychain through `security`. Windows and Linux used to
 * return null here with a "pending" comment, which meant the whole feature was
 * macOS-only in practice — the two platforms where the split above actually
 * bites. Both are implemented now:
 *
 *   Windows — PowerShell enumerates `Cert:\LocalMachine\Root`, `Cert:\CurrentUser\Root`
 *             and the intermediate `CA` stores and prints the matches as PEM.
 *   Linux   — the system trust anchors on disk are parsed with `node:crypto`'s
 *             X509Certificate and filtered by subject. No external tool, so it
 *             works the same on a minimal container as on a full desktop.
 *
 * SECURITY — the common name is user-supplied (Settings) and reaches a child
 * process. It is NEVER interpolated into the PowerShell program text: the
 * script reads it from an environment variable, so a name containing quotes,
 * `$(...)`, or a semicolon is data to the script rather than syntax. On the
 * Linux path it never leaves this process at all.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../lib/logger.js";

const log = createLogger("corp-ca");
const execFileAsync = promisify(execFile);

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

/** Cap on how much certificate text is parsed from any one source. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Cap on how many matching certificates are injected. */
const MAX_MATCHES = 32;

/**
 * Split a PEM blob into individual certificate blocks.
 *
 * Anything outside the BEGIN/END markers is dropped — trust bundles routinely
 * carry human-readable headers between certificates, and `X509Certificate`
 * rejects a block that still has them attached.
 */
export function splitPemBlocks(pem: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  for (;;) {
    const begin = pem.indexOf(PEM_BEGIN, index);
    if (begin === -1) break;
    const end = pem.indexOf(PEM_END, begin);
    if (end === -1) break;
    blocks.push(pem.slice(begin, end + PEM_END.length) + "\n");
    index = end + PEM_END.length;
  }
  return blocks;
}

/**
 * Does this certificate's subject carry the configured common name?
 *
 * Substring, case-insensitive, on the CN attribute only — the same shape as
 * `security find-certificate -c` on macOS, so the setting means one thing
 * across all three platforms. Matching the whole subject instead would let a
 * name typed for the CN match an organization or locality and inject a
 * certificate the user never asked for.
 */
export function subjectHasCommonName(subject: string, commonName: string): boolean {
  const needle = commonName.toLowerCase();
  for (const line of subject.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().startsWith("cn=")) continue;
    if (trimmed.slice(3).toLowerCase().includes(needle)) return true;
  }
  return false;
}

/**
 * Keep the certificate blocks whose subject CN matches, in input order,
 * skipping duplicates and anything that does not parse.
 *
 * An unparseable block is skipped rather than fatal: a system trust directory
 * is a shared location that routinely holds a stray file, and one bad entry
 * must not cost the user every certificate after it.
 */
export function selectCertificatesByCommonName(pem: string, commonName: string): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const block of splitPemBlocks(pem)) {
    if (matches.length >= MAX_MATCHES) break;
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(block);
    } catch {
      continue;
    }
    if (!subjectHasCommonName(cert.subject, commonName)) continue;
    const fingerprint = cert.fingerprint256;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    matches.push(block);
  }
  return matches;
}

// ─── Linux ───────────────────────────────────────────────────────────────────

/**
 * Where distributions keep trust anchors. Bundles first (one file, everything
 * the system trusts), then the drop-in directories an administrator or an MDM
 * writes a corporate root into.
 */
const LINUX_TRUST_SOURCES: readonly string[] = [
  "/etc/ssl/certs/ca-certificates.crt",
  "/etc/pki/tls/certs/ca-bundle.crt",
  "/etc/ssl/ca-bundle.pem",
  "/usr/local/share/ca-certificates",
  "/usr/share/ca-certificates",
  "/etc/pki/ca-trust/source/anchors",
  "/etc/ca-certificates/trust-source/anchors",
];

async function readCertSource(path: string): Promise<string> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return "";
  }
  if (info.isFile()) {
    if (info.size > MAX_SOURCE_BYTES) return "";
    try {
      return await readFile(path, "utf-8");
    } catch {
      return "";
    }
  }
  if (!info.isDirectory()) return "";
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const entry of entries.sort()) {
    if (!/\.(crt|pem|cer)$/i.test(entry)) continue;
    parts.push(await readCertSource(join(path, entry)));
  }
  return parts.join("\n");
}

/**
 * Read the Linux system trust anchors and return the matching certificates.
 *
 * Returns null when nothing matches, which is the ordinary case on a machine
 * with no corporate CA — the caller keeps the default verification.
 */
export async function extractLinuxCorporateCa(
  commonName: string,
  debugLog: boolean,
  sources: readonly string[] = LINUX_TRUST_SOURCES,
): Promise<string | null> {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const text = await readCertSource(source);
    if (text === "") continue;
    for (const block of selectCertificatesByCommonName(text, commonName)) {
      if (seen.has(block)) continue;
      seen.add(block);
      matches.push(block);
    }
    if (matches.length >= MAX_MATCHES) break;
  }
  if (matches.length === 0) {
    if (debugLog) {
      log.info("Linux: no trust anchor matched the configured certificate name");
    }
    return null;
  }
  if (debugLog) {
    log.info("Linux: %d trust anchor(s) matched", matches.length);
  }
  return matches.join("");
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/**
 * Enumerate the Windows certificate stores and print every match as PEM.
 *
 * The name is read from the environment rather than spliced into this text —
 * see the SECURITY note at the top of the file. `-like` needs a wildcard
 * pattern, and the name may itself contain `*`, `?`, or `[`, so the comparison
 * is a plain case-insensitive `Contains` on the CN attribute instead, matching
 * what {@link subjectHasCommonName} does for the other two platforms.
 */
const WINDOWS_EXPORT_SCRIPT = `
$ErrorActionPreference = 'Stop'
$needle = $env:LVIS_CORP_CA_QUERY
if ([string]::IsNullOrWhiteSpace($needle)) { exit 0 }
$stores = @(
  'Cert:\\LocalMachine\\Root',
  'Cert:\\LocalMachine\\CA',
  'Cert:\\CurrentUser\\Root',
  'Cert:\\CurrentUser\\CA'
)
foreach ($store in $stores) {
  if (-not (Test-Path $store)) { continue }
  foreach ($cert in (Get-ChildItem -Path $store -ErrorAction SilentlyContinue)) {
    $cn = ($cert.Subject -split ',') |
      Where-Object { $_.Trim().StartsWith('CN=', 'OrdinalIgnoreCase') } |
      ForEach-Object { $_.Trim().Substring(3) }
    if (-not $cn) { continue }
    $hit = $false
    foreach ($value in $cn) {
      if ($value.ToLowerInvariant().Contains($needle.ToLowerInvariant())) { $hit = $true }
    }
    if (-not $hit) { continue }
    Write-Output '-----BEGIN CERTIFICATE-----'
    Write-Output ([Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks'))
    Write-Output '-----END CERTIFICATE-----'
  }
}
`;

/**
 * Read the Windows certificate stores and return the matching certificates.
 *
 * PowerShell is invoked with `-NoProfile -NonInteractive` so a user profile
 * script cannot change what this returns, and the output is re-parsed through
 * {@link selectCertificatesByCommonName} rather than trusted as-is: what gets
 * injected into the TLS trust store is what this process could parse and
 * verify the subject of, not whatever text came back on stdout.
 */
export async function extractWindowsCorporateCa(
  commonName: string,
  debugLog: boolean,
): Promise<string | null> {
  try {
    const output = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_EXPORT_SCRIPT],
      {
        encoding: "utf8",
        timeout: 20_000,
        maxBuffer: MAX_SOURCE_BYTES,
        windowsHide: true,
        // The name travels as data, never as script text.
        env: { ...process.env, LVIS_CORP_CA_QUERY: commonName },
      },
    ) as unknown;
    const stdout =
      typeof output === "object" && output !== null && "stdout" in output
        ? (output as { stdout?: string | Buffer }).stdout
        : output;
    const text = Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
    const matches = selectCertificatesByCommonName(text, commonName);
    if (matches.length === 0) {
      if (debugLog) {
        log.info("Windows: no certificate store entry matched the configured name");
      }
      return null;
    }
    if (debugLog) {
      log.info("Windows: %d certificate(s) matched", matches.length);
    }
    return matches.join("");
  } catch (err) {
    // Never fatal: the app runs fine without injection on a machine with no
    // corporate CA, and PowerShell can be absent or locked down by policy.
    log.warn("Windows extraction failed: %s", (err as Error).message);
    return null;
  }
}
