/**
 * Acquisition of the corporate root CA from the operating system's trust store.
 *
 * Why this exists at all: Electron has two independent TLS stacks. Chromium's
 * network stack already trusts whatever the OS trusts, so pages load; Node's
 * does NOT — undici and `node:https` verify against the roots compiled into
 * Node. Every model call, marketplace fetch, and update check goes through the
 * Node side. On a machine behind a TLS-inspecting corporate proxy those all
 * fail while the browser half looks fine, which is exactly the confusing
 * half-broken state this module removes.
 *
 * ONE pipeline, three readers. Everything that decides WHICH certificate is
 * accepted — splitting the PEM, matching the common name, dropping duplicates,
 * capping the result — happens once, here, for every platform. A reader's only
 * job is to hand back the candidate certificate text its OS keeps:
 *
 *   macOS   — `security find-certificate` over the System keychain.
 *   Windows — PowerShell enumerates the LocalMachine and CurrentUser stores.
 *   Linux   — the trust anchors on disk, read directly. No external tool, so it
 *             works the same on a minimal container as on a full desktop.
 *
 * That split is the point: three platforms cannot drift into three different
 * ideas of what "the certificate is named X" means, and a reader that returns
 * something unexpected cannot widen what gets injected, because its output goes
 * through the same filter as everyone else's.
 *
 * SECURITY — the common name is user-supplied (Settings) and reaches a child
 * process. It is NEVER interpolated into the PowerShell program text: the
 * script reads it from an environment variable, so a name containing quotes,
 * `$(...)`, or a semicolon is data to the script rather than syntax. On macOS
 * it is one argv entry, and on Linux it never leaves this process at all.
 */
import { execFile } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../lib/logger.js";
import type { CorpCaConfig } from "../shared/corp-ca-config.js";

const log = createLogger("corp-ca");
const execFileAsync = promisify(execFile);

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

/** Cap on how much certificate text is read from any one source. */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

/** Cap on how many matching certificates are injected. */
const MAX_MATCHES = 32;

/**
 * What a lookup needs to know. `enabled` is the caller's business — by the time
 * a reader runs, the decision to look at all has been made.
 */
export type CorpCaLookup = Pick<CorpCaConfig, "commonName" | "debugLog">;

// ─── Shared certificate handling — the part that is NOT per-platform ─────────

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
 * How many certificates a PEM blob holds.
 *
 * The one answer to that question: the cache reader, the log lines, and the
 * result count all ask it, and a `BEGIN` tally would count a truncated block
 * that nothing can parse.
 */
export function countCertificates(pem: string): number {
  return splitPemBlocks(pem).length;
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
 * This is the gate every platform's output passes through, which is why the
 * readers do not filter, deduplicate, or count for themselves. It matters most
 * for the two that ask another program: what gets injected is what THIS process
 * could parse and verify the subject of, not whatever text came back on stdout.
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

/**
 * Run a trust-store tool and return its stdout, or "" when it could not run.
 *
 * Never throws: the app works fine without injection on a machine that has no
 * corporate CA, and both tools this calls can be absent, slow, or refused by
 * policy. The error TEXT is logged, never its output — that is certificate
 * material and, on Windows, includes the name the user typed.
 */
async function runTrustStoreTool(
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const output = await execFileAsync(file, [...args], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: MAX_SOURCE_BYTES,
      windowsHide: true,
      ...(env === undefined ? {} : { env }),
    }) as unknown;
    const stdout =
      typeof output === "object" && output !== null && "stdout" in output
        ? (output as { stdout?: string | Buffer }).stdout
        : output;
    return Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? "");
  } catch (err) {
    log.warn("%s lookup failed: %s", file, (err as Error).message);
    return "";
  }
}

// ─── macOS ───────────────────────────────────────────────────────────────────

async function readMacosTrustStore(lookup: CorpCaLookup): Promise<string> {
  // `-c` is the tool's own name filter; the shared selector re-checks the CN
  // anyway, so the two platforms that cannot pre-filter behave identically.
  return await runTrustStoreTool("security", [
    "find-certificate",
    "-a",
    "-c",
    lookup.commonName,
    "-p",
    "/Library/Keychains/System.keychain",
  ]);
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/**
 * Enumerate the Windows certificate stores and print every candidate as PEM.
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

async function readWindowsTrustStore(lookup: CorpCaLookup): Promise<string> {
  // `-NoProfile -NonInteractive` so a user profile script cannot change what
  // comes back, and the name travels as data, never as script text.
  return await runTrustStoreTool(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_EXPORT_SCRIPT],
    { ...process.env, LVIS_CORP_CA_QUERY: lookup.commonName },
  );
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

/**
 * One regular file, read through a single descriptor. "" for anything else.
 *
 * The size check and the read happen on the SAME open handle rather than on the
 * path: a `stat(path)` followed by `readFile(path)` describes one file and then
 * reads whatever the path points at afterwards, which for a trust-store path is
 * exactly the swap worth not being exposed to.
 */
async function readCertFile(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return "";
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_SOURCE_BYTES) return "";
    return await handle.readFile("utf-8");
  } catch {
    return "";
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One file, or every certificate file one directory deep. "" when unreadable. */
async function readCertSource(path: string): Promise<string> {
  const fileText = await readCertFile(path);
  if (fileText !== "") return fileText;
  // Not a readable regular file — the other thing a trust source can be is a
  // directory of drop-in anchors. `readdir` fails for everything else, which
  // is the same "" this returns for an unreadable file.
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
 * Concatenate the Linux system trust anchors.
 *
 * Every distribution ships the same anchor in a bundle AND as a drop-in file,
 * so this returns duplicates by design — the shared selector removes them by
 * fingerprint, which is also what catches the same certificate arriving under
 * two different file names.
 *
 * `sources` is a parameter so a test can point at a temp directory; nothing
 * else overrides it.
 */
export async function readLinuxTrustStore(
  _lookup: CorpCaLookup,
  sources: readonly string[] = LINUX_TRUST_SOURCES,
): Promise<string> {
  const parts: string[] = [];
  for (const source of sources) {
    const text = await readCertSource(source);
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

type TrustStoreReader = (lookup: CorpCaLookup) => Promise<string>;

/**
 * The only place platform is branched on. Adding a platform means adding a
 * reader here; it cannot mean adding another idea of what a match is.
 */
const TRUST_STORE_READERS: Partial<Record<NodeJS.Platform, TrustStoreReader>> = {
  darwin: readMacosTrustStore,
  win32: readWindowsTrustStore,
  linux: readLinuxTrustStore,
};

/**
 * The corporate root CA for this machine, or null when there is none to find.
 *
 * Null is the ordinary outcome on a machine with no corporate CA — the caller
 * keeps the default verification and says so once. `readers` is a parameter so
 * a test can drive the shared half without a real trust store.
 */
export async function extractCorporateCa(
  lookup: CorpCaLookup,
  platform: NodeJS.Platform = process.platform,
  readers: Partial<Record<NodeJS.Platform, TrustStoreReader>> = TRUST_STORE_READERS,
): Promise<string | null> {
  const read = readers[platform];
  if (read === undefined) {
    log.warn("unsupported platform %s — skipping the certificate lookup", platform);
    return null;
  }
  const matches = selectCertificatesByCommonName(await read(lookup), lookup.commonName);
  if (matches.length === 0) {
    // Not warned about here: the caller already says once, unconditionally,
    // that no corporate CA was found and that verification is unchanged. A
    // second line for the same fact would be noise on every launch of every
    // machine that has no such certificate, which is most of them.
    if (lookup.debugLog) {
      log.info("%s: no certificate in the trust store matched the configured name", platform);
    }
    return null;
  }
  if (lookup.debugLog) {
    log.info("%s: %d certificate(s) matched", platform, matches.length);
  }
  return matches.join("");
}
