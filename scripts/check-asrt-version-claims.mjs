/**
 * check-asrt-version-claims.mjs — the ASRT capability claims must name the ASRT we ship
 *
 * WHY THIS GATE EXISTS. LVIS is tightly coupled to `@anthropic-ai/sandbox-runtime`,
 * and that coupling is carried in PROSE: thirty-odd comments across the permission,
 * plugin-isolation and MCP layers justify a workaround by naming what a specific ASRT
 * version cannot do ("ASRT 0.0.73 cannot apply per-server filesystem.allowRead", "the
 * per-command allowUnixSockets is INERT"). Each one is load-bearing — delete the
 * workaround and the sandbox silently stops confining something.
 *
 * Those claims decay silently. When the dependency moves, every "ASRT <old>" sentence
 * becomes a statement about a version we no longer ship, and the workaround it
 * justifies may have become dead weight — or worse, may now be papering over
 * behaviour that changed underneath it. Nothing in a version bump makes anyone
 * re-read them: a bump is a one-line diff in package.json and a lockfile.
 *
 * So this gate makes the bump surface them. Two rules:
 *
 *   1. No claim may name a version NEWER than the one package.json pins. A sentence
 *      about a version we do not ship describes something nobody here can observe.
 *   2. The pinned version must be named by at least one claim. A bump drops that to
 *      zero and fails here, and the failure prints every site still naming the old
 *      version. That list IS the re-read checklist: whoever bumps walks it, confirms
 *      or deletes each workaround, and re-stamps the ones that survive.
 *
 * Rule 2 is the whole point, and it is why this is a gate rather than a lint. It does
 * not detect that a capability changed — nothing static can. It guarantees that a
 * human looked, which for a coupling this deep is the honest thing to promise.
 *
 * Claims naming an OLDER version stay: "ASRT 0.0.67 REMOVED implicit vendored-binary
 * resolution" is a fact about when something changed, not a claim about what we ship,
 * and re-stamping it to the current pin would make it false.
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import process from "node:process";
import { walkSourceFiles } from "./lib/source-walk.mjs";

const ROOT = process.cwd();
const PACKAGE = "@anthropic-ai/sandbox-runtime";
/** `ASRT 0.0.73`, the shape every claim in this tree uses. */
const CLAIM = /\bASRT (\d+\.\d+\.\d+)/g;
const SCAN_DIRS = ["src", "scripts", "docs"];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "out", ".claude", ".worktrees"]);
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js", ".md"];

/** Compare two `x.y.z` strings numerically, not as text: 0.0.9 < 0.0.73. */
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** The exact version package.json pins. A range would make "the version we ship"
 *  unanswerable, so a range is itself the failure. */
export function pinnedAsrtVersion(root = ROOT) {
  const pkg = JSON.parse(readFileSync(`${root}/package.json`, "utf-8"));
  const spec = pkg.dependencies?.[PACKAGE] ?? pkg.devDependencies?.[PACKAGE];
  if (spec === undefined) return { error: `${PACKAGE} is not a dependency` };
  if (!/^\d+\.\d+\.\d+$/.test(spec)) {
    return { error: `${PACKAGE} is pinned as "${spec}"; this gate needs an exact version` };
  }
  return { version: spec };
}

export function collectAsrtClaims(root = ROOT) {
  const claims = [];
  for (const dir of SCAN_DIRS) {
    for (const path of walkSourceFiles(`${root}/${dir}`, {
      skipDirs: SKIP_DIRS,
      extensions: EXTENSIONS,
      tolerateUnreadableDirs: true,
    })) {
      const text = readFileSync(path, "utf-8");
      if (!text.includes("ASRT ")) continue;
      const lines = text.split("\n");
      for (const [index, line] of lines.entries()) {
        for (const match of line.matchAll(CLAIM)) {
          claims.push({ rel: relative(root, path), line: index + 1, version: match[1] });
        }
      }
    }
  }
  return claims;
}

export function checkAsrtVersionClaims(root = ROOT) {
  const pin = pinnedAsrtVersion(root);
  if (pin.error) return { ok: false, problems: [pin.error], claims: [] };
  const claims = collectAsrtClaims(root);
  const problems = [];

  const ahead = claims.filter((c) => compareVersions(c.version, pin.version) > 0);
  for (const c of ahead) {
    problems.push(
      `${c.rel}:${c.line} claims something about ASRT ${c.version}, but this tree ships ${pin.version}`,
    );
  }

  const current = claims.filter((c) => c.version === pin.version);
  if (current.length === 0) {
    const stale = [...new Set(claims.map((c) => c.version))].sort(compareVersions).reverse();
    problems.push(
      `no claim names ASRT ${pin.version}. The pin moved and the capability claims did not: ` +
        `re-read each site below against ${pin.version}, delete the workarounds it no longer ` +
        `needs, and re-stamp the ones that survive. Versions still claimed: ${stale.join(", ") || "none"}`,
    );
  }
  return { ok: problems.length === 0, problems, claims, pinned: pin.version, current: current.length };
}

export function runAsrtClaimsCli(options = {}) {
  const root = options.root ?? ROOT;
  const stdout = options.stdout ?? console.log;
  const stderr = options.stderr ?? console.error;
  const result = checkAsrtVersionClaims(root);
  if (result.ok) {
    stdout(
      `[asrt-claims] OK — ${result.current} claim(s) name the pinned ASRT ${result.pinned}, ` +
        `${result.claims.length - result.current} historical`,
    );
    return 0;
  }
  for (const problem of result.problems) stderr(`[asrt-claims] ${problem}`);
  if (result.current === 0 && result.claims.length > 0) {
    stderr("[asrt-claims] sites to re-read:");
    for (const c of result.claims) stderr(`  ${c.rel}:${c.line}  (ASRT ${c.version})`);
  }
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = runAsrtClaimsCli();
}
